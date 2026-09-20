import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runArm,
  scoredArms,
  timingArms,
  type ArmDefinition,
  type RunArmParams,
} from "../src/experiment_runner.ts";
import { DEFAULT_PROTOCOL_LOCK_PATH, DEFAULT_PROTOCOL_PATH, loadProtocol, verifyExperimentFreeze, type CheckerProtocol } from "../src/checker_protocol.ts";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet, type CaseSet } from "../src/case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH, loadRoster, type Roster } from "../src/roster.ts";
import { GatewayClient } from "../src/gateway_client.ts";

const protocol: CheckerProtocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
const caseSet: CaseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const roster: Roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);
const freeze = verifyExperimentFreeze({
  caseSetPath: DEFAULT_CASE_SET_PATH,
  caseSetLockPath: DEFAULT_CASE_SET_LOCK_PATH,
  rosterPath: DEFAULT_ROSTER_PATH,
  rosterLockPath: DEFAULT_ROSTER_LOCK_PATH,
  protocolPath: DEFAULT_PROTOCOL_PATH,
  protocolLockPath: DEFAULT_PROTOCOL_LOCK_PATH,
});

const COMMIT = "f".repeat(40);

function baseParams(overrides: Partial<RunArmParams>): RunArmParams {
  return {
    arm: { name: "rules", checker: "rules", modelId: null, variant: "rules", decisionPolicy: "value-presence", timingRun: false },
    caseSet,
    roster,
    protocol,
    freeze,
    commit: COMMIT,
    repeatCount: 1,
    outputDir: mkdtempSync(join(tmpdir(), "faai-runner-")),
    ...overrides,
  };
}

describe("arm enumeration", () => {
  test("the scored arms are rules, jev and both configurations of every pinned model", () => {
    const names = scoredArms(protocol).map((arm) => arm.name);
    expect(names).toEqual([
      "rules",
      "jev",
      "claude-sonnet-5-overall",
      "claude-sonnet-5-three",
      "gemini-3.8-flash-overall",
      "gemini-3.8-flash-three",
      "gpt-5.4-mini-overall",
      "gpt-5.4-mini-three",
      "claude-haiku-4.5-overall",
      "claude-haiku-4.5-three",
    ]);
  });

  test("the timing arms are verdict-only, separately labelled, and exclude rules", () => {
    const arms = timingArms(protocol);
    expect(arms.map((arm) => arm.name)).toEqual([
      "jev-verdict-only",
      "claude-sonnet-5-overall-verdict-only",
      "claude-sonnet-5-three-verdict-only",
      "gemini-3.8-flash-overall-verdict-only",
      "gemini-3.8-flash-three-verdict-only",
      "gpt-5.4-mini-overall-verdict-only",
      "gpt-5.4-mini-three-verdict-only",
      "claude-haiku-4.5-overall-verdict-only",
      "claude-haiku-4.5-three-verdict-only",
    ]);
    expect(arms.every((arm) => arm.timingRun)).toBe(true);
    expect(arms.every((arm) => arm.name.endsWith("-verdict-only"))).toBe(true);
  });
});

describe("runArm (rules, offline)", () => {
  test("records one evaluation per card per repeat with a manifest bound to the freeze", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-rules-"));
    const result = await runArm(baseParams({ repeatCount: 2, outputDir: dir }));

    expect(result.recordCount).toBe(100);
    expect(result.passed + result.reviewed).toBe(100);
    expect(result.inputPreparationErrors).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.protocol_version).toBe("0.1.0");
    expect(manifest.protocol_sha256).toBe(freeze.protocolSha256);
    expect(manifest.case_set_sha256).toBe(freeze.caseSetSha256);
    expect(manifest.roster_sha256).toBe(freeze.rosterSha256);
    expect(manifest.arm).toMatchObject({ name: "rules", variant: "rules", decision_policy: "value-presence", timing_run: false });
    expect(manifest.repeat_count).toBe(2);

    const records = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records).toHaveLength(100);
    const first = records[0]!;
    expect(first.model).toBeNull();
    expect(first.usage).toBeNull();
    expect(first.raw_answer).toEqual({ value_present: true });
    expect(first.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the rules checker passes a wrong-subject card: the dangerous pass the experiment exists to show", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-rules2-"));
    await runArm(baseParams({ outputDir: dir }));
    const records = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const wrongSubject = records.find((r: { card_id: string }) => r.card_id === "card-sp-10");
    const card = caseSet.cards.find((c) => c.id === "card-sp-10")!;
    expect(card.category).toBe("wrong-subject");
    expect(wrongSubject.decision.outcome).toBe("pass");
  });
});

describe("runArm (networked)", () => {
  test("fails with a useful message before writing anything when the gateway key is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-nokey-"));
    const arm: ArmDefinition = {
      name: "jev",
      checker: "jev",
      modelId: "typesafe-ai/jev",
      variant: "decomposed",
      decisionPolicy: "probability-gated",
      timingRun: false,
    };
    await expect(
      runArm(baseParams({ arm, outputDir: dir, client: new GatewayClient({ apiKey: undefined }) })),
    ).rejects.toThrow(/AI_GATEWAY_API_KEY/);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "records.jsonl"))).toBe(false);
  });

  test("refuses to start when the output directory already holds a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-exists-"));
    await runArm(baseParams({ outputDir: dir }));
    await expect(runArm(baseParams({ outputDir: dir }))).rejects.toThrow(/already exists/);
  });
});

describe("runArm (input-preparation errors)", () => {
  test("records an input-preparation error per repeat and never drops the card", async () => {
    const brokenRoster: Roster = {
      ...roster,
      entries: roster.entries.filter((e) => e.subject_id !== "sub-sp-priya"),
    };
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-prep-"));
    const result = await runArm(baseParams({ roster: brokenRoster, outputDir: dir, repeatCount: 2 }));
    expect(result.recordCount).toBe(100);

    const records = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const broken = records.filter((r: { card_id: string }) => r.card_id === "card-sp-01");
    expect(broken).toHaveLength(2);
    for (const record of broken) {
      expect(record.error.kind).toBe("input-preparation");
      expect(record.attempts).toEqual([]);
      expect(record.model).toBeNull();
      expect(record.decision).toBeNull();
      expect(record.model_input).toBeNull();
      expect(record.input_hash).toBeNull();
      expect(record.error.message).toContain("sub-sp-priya");
    }
    const healthy = records.find((r: { card_id: string }) => r.card_id === "card-sp-02");
    expect(healthy.error).toBeNull();
  });
});

describe("runArm (deferred generation usage)", () => {
  const jevArm: ArmDefinition = {
    name: "jev",
    checker: "jev",
    modelId: "typesafe-ai/jev",
    variant: "decomposed",
    decisionPolicy: "probability-gated",
    timingRun: false,
  };

  function jevBody(): Record<string, unknown> {
    return {
      model: "jev-1.13.0",
      answers: {
        ownership: { type: "choice", choice: "Priya Sharma", probabilities: { "Priya Sharma": 0.93, "Dev Patel": 0.07 } },
        value_support: { type: "noul", noul: 0.95 },
        time_support: { type: "noul", noul: 0.92 },
      },
      usage: { input_tokens: 640, output_tokens: 20 },
      provider_metadata: {
        gateway: {
          cost: "0",
          marketCost: "0.0000123",
          generationId: "gen_test_1",
          routing: { resolvedProvider: "typesafe-ai" },
        },
      },
    };
  }

  function generationBody(): Record<string, unknown> {
    return {
      data: {
        id: "gen_test_1",
        model: "jev-1.13.0",
        provider_name: "typesafe-ai",
        total_cost: 0,
        market_cost: 0.0000123,
        latency: 180,
        tokens_prompt: 640,
        tokens_completion: 20,
      },
    };
  }

  test("fills usage from the deferred generation lookup and upgrades the model report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-gen-"));
    const client = new GatewayClient({
      apiKey: "test-key",
      fetch: ((url: string | URL) => {
        const target = String(url);
        if (target.includes("/typesafe/v1/systemone")) {
          return Promise.resolve(new Response(JSON.stringify(jevBody()), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (target.includes("/v1/generation")) {
          return Promise.resolve(new Response(JSON.stringify(generationBody()), { status: 200, headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`unexpected url ${target}`));
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await runArm(
      baseParams({ arm: jevArm, outputDir: dir, repeatCount: 1, client, generationIngestionDelayMs: 0, sleep: async () => {} }),
    );
    expect(result.recordCount).toBe(50);
    expect(result.executionErrors).toBe(0);

    const records = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const record of records) {
      expect(record.attempts[0].generation_id).toBe("gen_test_1");
      expect(record.attempts[0].usage).toEqual({
        latency_ms: 180,
        input_tokens: 640,
        output_tokens: 20,
        cost: { amount: 0, currency: "USD" },
      });
      expect(record.attempts[0].generation.market_cost).toBe(0.0000123);
      expect(record.model.version).toBe("jev-1.13.0");
      expect(record.model.provider).toBe("typesafe-ai");
      expect(record.decision).not.toBeNull();
    }
  });

  test("an answer whose usage never arrives is an execution error, never a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-runner-nogen-"));
    const client = new GatewayClient({
      apiKey: "test-key",
      fetch: ((url: string | URL) => {
        const target = String(url);
        if (target.includes("/typesafe/v1/systemone")) {
          return Promise.resolve(new Response(JSON.stringify(jevBody()), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (target.includes("/v1/generation")) {
          return Promise.resolve(new Response(JSON.stringify({ error: "Usage event not found" }), { status: 404 }));
        }
        return Promise.reject(new Error(`unexpected url ${target}`));
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await runArm(
      baseParams({ arm: jevArm, outputDir: dir, repeatCount: 1, client, generationIngestionDelayMs: 0, sleep: async () => {} }),
    );
    expect(result.executionErrors).toBe(50);
    expect(result.passed).toBe(0);

    const records = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const record of records) {
      expect(record.decision).toBeNull();
      expect(record.error.kind).toBe("other");
      expect(record.error.message).toContain("gateway-reported usage");
    }
  });
});
