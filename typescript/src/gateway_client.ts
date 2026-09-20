import { GatewayHttpError, GatewayTimeoutError } from "./gateway_backoff.ts";
import type { GatewayUsage } from "./run_record_schema.ts";

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const SYSTEM_ONE_PATH = "/typesafe/v1/systemone";
const GENERATION_PATH = "/v1/generation";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "AI_GATEWAY_API_KEY is absent: networked checkers route through the Vercel AI Gateway and cannot run offline. " +
        "Copy .env.example to .env at the repository root and fill in the key, or export AI_GATEWAY_API_KEY. " +
        "The rules checker runs offline without credentials.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function apiKeyFromEnv(env: Record<string, string | undefined>): string {
  const key = env["AI_GATEWAY_API_KEY"];
  if (key === undefined || key.trim().length === 0) throw new MissingApiKeyError();
  return key.trim();
}

export interface ChatCompletionRequest {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
  };
  max_tokens?: number;
}

export interface ChatCompletionResult {
  body: Record<string, unknown>;
  content: string | null;
  generationId: string | null;
  modelVersion: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
}

export interface SystemOneResult {
  body: Record<string, unknown>;
  answers: Record<string, unknown> | null;
  modelVersion: string | null;
  generationId: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  gatewayCost: number | null;
  provider: string | null;
}

export interface GenerationInfo {
  id: string;
  model: string;
  provider: string;
  /** The gateway-reported charged cost (total_cost); 0 when the call is covered by credits. */
  cost: number | null;
  /** The gateway-reported list-price cost (market_cost): what the call would cost at list price. */
  marketCost: number | null;
  /** Gateway-reported latency in ms; 0 or null when the gateway reports none for this generation. */
  latency: number | null;
  /** Gateway-reported total generation time in ms, present when latency is not. */
  generationTime: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** The raw lookup payload, preserved verbatim in run records. */
  raw: Record<string, unknown>;
}

export function generationLatencyMs(info: GenerationInfo): number | null {
  if (info.latency !== null && info.latency > 0) return info.latency;
  if (info.generationTime !== null && info.generationTime > 0) return info.generationTime;
  return null;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GatewayClientOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GatewayClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: GatewayClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input as Parameters<typeof fetch>[0], init as RequestInit | undefined));
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  ensureAuthenticated(): void {
    this.requireApiKey();
  }

  private requireApiKey(): string {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) throw new MissingApiKeyError();
    return this.apiKey;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const apiKey = this.requireApiKey();
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") {
        throw new GatewayTimeoutError(`gateway call to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GatewayHttpError(response.status, `gateway returned HTTP ${response.status} from ${path}: ${text.slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const body = await this.post<Record<string, unknown>>(CHAT_COMPLETIONS_PATH, request);
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(first.message) ? first.message : {};
    const usage = isRecord(body.usage) ? body.usage : null;
    return {
      body,
      content: typeof message.content === "string" ? message.content : null,
      generationId: typeof body.id === "string" ? body.id : null,
      modelVersion: typeof body.model === "string" ? body.model : null,
      usage:
        usage !== null && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
          ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
          : null,
    };
  }

  async systemOne(request: SystemOneRequest): Promise<SystemOneResult> {
    const body = await this.post<Record<string, unknown>>(SYSTEM_ONE_PATH, request);
    const providerMetadata = isRecord(body.provider_metadata) ? body.provider_metadata : {};
    const gateway = isRecord(providerMetadata.gateway) ? providerMetadata.gateway : {};
    const routing = isRecord(gateway.routing) ? gateway.routing : {};
    const usage = isRecord(body.usage) ? body.usage : null;
    return {
      body,
      answers: isRecord(body.answers) ? body.answers : null,
      modelVersion: typeof body.model === "string" ? body.model : null,
      generationId: typeof gateway.generationId === "string" ? gateway.generationId : null,
      usage:
        usage !== null && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
          ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
          : null,
      gatewayCost: typeof gateway.cost === "string" ? Number(gateway.cost) : typeof gateway.cost === "number" ? gateway.cost : null,
      provider: typeof routing.resolvedProvider === "string" ? routing.resolvedProvider : null,
    };
  }

  async lookupGeneration(generationId: string): Promise<GenerationInfo | null> {
    const apiKey = this.requireApiKey();
    const response = await this.doFetch(`${this.baseUrl}${GENERATION_PATH}?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GatewayHttpError(response.status, `generation lookup returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = (await response.json()) as Record<string, unknown>;
    const body = isRecord(parsed.data) ? parsed.data : parsed;
    const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
      id: typeof body.id === "string" ? body.id : generationId,
      model: typeof body.model === "string" ? body.model : "",
      provider: typeof body.provider_name === "string" ? body.provider_name : "",
      cost: numberOrNull(body.total_cost),
      marketCost: numberOrNull(body.market_cost),
      latency: numberOrNull(body.latency),
      generationTime: numberOrNull(body.generation_time),
      input_tokens: numberOrNull(body.tokens_prompt),
      output_tokens: numberOrNull(body.tokens_completion),
      raw: body,
    };
  }

  async lookupGenerationWithPolling(
    generationId: string,
    options: { tries?: number; delayMs?: number } = {},
  ): Promise<GenerationInfo | null> {
    const tries = options.tries ?? 6;
    const delayMs = options.delayMs ?? 1_000;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const info = await this.lookupGeneration(generationId);
      if (info !== null && generationLatencyMs(info) !== null) return info;
      if (attempt < tries) await this.sleep(delayMs);
    }
    return null;
  }
}

export function attemptUsageFromGeneration(
  info: GenerationInfo | null,
  bodyTokens: { input_tokens: number; output_tokens: number } | null,
): GatewayUsage | null {
  if (info === null) return null;
  const latency = generationLatencyMs(info);
  if (latency === null) return null;
  const inputTokens = info.input_tokens ?? bodyTokens?.input_tokens ?? null;
  const outputTokens = info.output_tokens ?? bodyTokens?.output_tokens ?? null;
  if (inputTokens === null || outputTokens === null) return null;
  return {
    latency_ms: latency,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost: info.cost === null || info.cost === undefined ? null : { amount: info.cost, currency: "USD" },
  };
}

export function loadDotEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
