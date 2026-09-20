import { describe, expect, test } from "bun:test";
import {
  GatewayClient,
  MissingApiKeyError,
  apiKeyFromEnv,
  attemptUsageFromGeneration,
  generationLatencyMs,
  type ChatCompletionRequest,
  type SystemOneRequest,
} from "../src/gateway_client.ts";
import { GatewayHttpError, GatewayTimeoutError } from "../src/gateway_backoff.ts";

const KEY = "test-gateway-key";

function makeClient(fetchStub: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return new GatewayClient({
    apiKey: KEY,
    baseUrl: "https://ai-gateway.vercel.sh",
    fetch: fetchStub,
    sleep: async () => {},
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CHAT_REQUEST: ChatCompletionRequest = {
  model: "anthropic/claude-sonnet-5",
  messages: [{ role: "user", content: "check this card" }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
  },
  max_tokens: 300,
};

describe("apiKeyFromEnv", () => {
  test("returns the key when present", () => {
    expect(apiKeyFromEnv({ AI_GATEWAY_API_KEY: KEY })).toBe(KEY);
  });

  test("fails with a useful message when the key is absent", () => {
    expect(() => apiKeyFromEnv({})).toThrow(MissingApiKeyError);
    expect(() => apiKeyFromEnv({})).toThrow(/AI_GATEWAY_API_KEY/);
  });

  test("a blank key counts as absent", () => {
    expect(() => apiKeyFromEnv({ AI_GATEWAY_API_KEY: "" })).toThrow(MissingApiKeyError);
  });
});

describe("GatewayClient.chatCompletion", () => {
  test("posts the exact request with the bearer key and maps the response", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const client = makeClient((input, init) => {
      seen.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse(200, {
          id: "gen_abc",
          model: "anthropic/claude-sonnet-5",
          choices: [{ message: { role: "assistant", content: '{"verdict":"supported","reason":"ok"}' } }],
          usage: { prompt_tokens: 640, completion_tokens: 24 },
        }),
      );
    });
    const result = await client.chatCompletion(CHAT_REQUEST);
    expect(seen[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect((seen[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual(CHAT_REQUEST);
    expect(result.generationId).toBe("gen_abc");
    expect(result.content).toBe('{"verdict":"supported","reason":"ok"}');
    expect(result.usage).toEqual({ input_tokens: 640, output_tokens: 24 });
    expect(result.modelVersion).toBe("anthropic/claude-sonnet-5");
  });

  test("maps HTTP 429 and other HTTP errors onto GatewayHttpError", async () => {
    const rateLimited = makeClient(() => Promise.resolve(jsonResponse(429, { error: "slow down" })));
    await expect(rateLimited.chatCompletion(CHAT_REQUEST)).rejects.toMatchObject({ name: "GatewayHttpError", status: 429 });

    const broken = makeClient(() => Promise.resolve(jsonResponse(502, { error: "bad gateway" })));
    await expect(broken.chatCompletion(CHAT_REQUEST)).rejects.toMatchObject({ name: "GatewayHttpError", status: 502 });
  });

  test("maps an aborted request onto GatewayTimeoutError", async () => {
    const timeoutClient = new GatewayClient({
      apiKey: KEY,
      baseUrl: "https://ai-gateway.vercel.sh",
      fetch: () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      },
      sleep: async () => {},
    });
    await expect(timeoutClient.chatCompletion(CHAT_REQUEST)).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  test("rejects before any network call when the key is missing", async () => {
    const client = new GatewayClient({ apiKey: undefined, baseUrl: "https://ai-gateway.vercel.sh" });
    await expect(client.chatCompletion(CHAT_REQUEST)).rejects.toThrow(MissingApiKeyError);
  });
});

describe("GatewayClient.systemOne", () => {
  const SYSTEM_ONE_REQUEST: SystemOneRequest = {
    model: "typesafe-ai/jev",
    state: { claim: { subject: "Alex Field" } },
    questions: {
      value_support: { type: "noul", instructions: "Does the source explicitly state this value for this field?" },
    },
  };

  test("posts to the typesafe endpoint and maps answers, cost and provider metadata", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const client = makeClient((input, init) => {
      seen.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse(200, {
          model: "jev-1.13.0",
          answers: { value_support: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 296, output_tokens: 20 },
          provider_metadata: {
            gateway: {
              cost: "0.00001155",
              generationId: "gen_xyz",
              routing: { resolvedProvider: "typesafe-ai", canonicalSlug: "typesafe-ai/jev" },
            },
          },
        }),
      );
    });
    const result = await client.systemOne(SYSTEM_ONE_REQUEST);
    expect(seen[0]!.url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(result.modelVersion).toBe("jev-1.13.0");
    expect(result.answers).toEqual({ value_support: { type: "noul", noul: 0.95 } });
    expect(result.generationId).toBe("gen_xyz");
    expect(result.usage).toEqual({ input_tokens: 296, output_tokens: 20 });
    expect(result.gatewayCost).toBe(0.00001155);
    expect(result.provider).toBe("typesafe-ai");
  });

  test("rejects before any network call when the key is missing", async () => {
    const client = new GatewayClient({ apiKey: undefined, baseUrl: "https://ai-gateway.vercel.sh" });
    await expect(client.systemOne(SYSTEM_ONE_REQUEST)).rejects.toThrow(MissingApiKeyError);
  });
});

describe("GatewayClient.lookupGeneration", () => {
  test("reads the data-wrapped payload: charged cost, market cost, latency and tokens", async () => {
    const client = makeClient((input) => {
      expect(String(input)).toContain("https://ai-gateway.vercel.sh/v1/generation?id=gen_abc");
      return Promise.resolve(
        jsonResponse(200, {
          data: {
            id: "gen_abc",
            model: "anthropic/claude-sonnet-5-20261001",
            provider_name: "anthropic",
            total_cost: 0.00123,
            market_cost: 0.0014,
            latency: 812,
            tokens_prompt: 640,
            tokens_completion: 24,
          },
        }),
      );
    });
    const info = await client.lookupGeneration("gen_abc");
    expect(info?.model).toBe("anthropic/claude-sonnet-5-20261001");
    expect(info?.provider).toBe("anthropic");
    expect(info?.cost).toBe(0.00123);
    expect(info?.marketCost).toBe(0.0014);
    expect(info?.latency).toBe(812);
    expect(info?.input_tokens).toBe(640);
    expect(info?.output_tokens).toBe(24);
  });

  test("falls back to generation_time when the gateway reports no latency", () => {
    const info = {
      id: "g", model: "m", provider: "p", cost: 0, marketCost: 0, latency: 0, generationTime: 266,
      input_tokens: 1, output_tokens: 1, raw: {},
    };
    expect(generationLatencyMs(info)).toBe(266);
    expect(generationLatencyMs({ ...info, latency: 40 })).toBe(40);
  });

  test("returns null while the usage event is not yet ingested, then the polling helper finds it", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(jsonResponse(404, { error: "Usage event not found" }));
      return Promise.resolve(
        jsonResponse(200, {
          data: { id: "gen_abc", model: "m", provider_name: "p", total_cost: 0.001, market_cost: 0.001, latency: 5, tokens_prompt: 1, tokens_completion: 1 },
        }),
      );
    });
    expect(await client.lookupGeneration("gen_abc")).toBeNull();
    const info = await client.lookupGenerationWithPolling("gen_abc", { tries: 5, delayMs: 0 });
    expect(info?.latency).toBe(5);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("attemptUsageFromGeneration", () => {
  test("assembles gateway-reported usage from the generation lookup, falling back to body tokens", () => {
    expect(
      attemptUsageFromGeneration(
        {
          id: "g", model: "m", provider: "p", cost: 0.001, marketCost: 0.002, latency: 812, generationTime: 900,
          input_tokens: null, output_tokens: null, raw: {},
        },
        { input_tokens: 640, output_tokens: 24 },
      ),
    ).toEqual({ latency_ms: 812, input_tokens: 640, output_tokens: 24, cost: { amount: 0.001, currency: "USD" } });
    expect(attemptUsageFromGeneration(null, { input_tokens: 640, output_tokens: 24 })).toBeNull();
  });

  test("records a missing cost as null, never an estimate", () => {
    const usage = attemptUsageFromGeneration(
      { id: "g", model: "m", provider: "p", cost: null, marketCost: null, latency: 5, generationTime: 9, input_tokens: 1, output_tokens: 1, raw: {} },
      null,
    );
    expect(usage?.cost).toBeNull();
  });
});
