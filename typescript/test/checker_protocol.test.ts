import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROTOCOL_LOCK_PATH,
  DEFAULT_PROTOCOL_PATH,
  ProtocolValidationError,
  loadProtocol,
  validateCheckerProtocol,
  verifyExperimentFreeze,
  verifyProtocolLock,
  type CheckerProtocol,
} from "../src/checker_protocol.ts";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH } from "../src/case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH } from "../src/roster.ts";

function readProtocolFixture(): CheckerProtocol {
  return JSON.parse(readFileSync(DEFAULT_PROTOCOL_PATH, "utf8")) as CheckerProtocol;
}

function writeTampered(protocol: CheckerProtocol, mutate: (p: CheckerProtocol) => void): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "faai-protocol-"));
  const path = join(dir, "protocol.json");
  const copy = structuredClone(protocol);
  mutate(copy);
  writeFileSync(path, JSON.stringify(copy, null, 2));
  return { dir, path };
}

describe("validateCheckerProtocol", () => {
  test("the frozen protocol v0.2 is valid", () => {
    expect(validateCheckerProtocol(readProtocolFixture())).toEqual([]);
  });

  test("rejects swapped or out-of-range noul thresholds", () => {
    const protocol = readProtocolFixture();
    const swapped = writeTampered(protocol, (p) => {
      p.decision_thresholds.noul_gate.pass_at_or_above = 0.1;
      p.decision_thresholds.noul_gate.unsupported_at_or_below = 0.9;
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(swapped.path, "utf8"))).length).toBeGreaterThan(0);

    const outOfRange = writeTampered(protocol, (p) => {
      p.decision_thresholds.noul_gate.pass_at_or_above = 1.5;
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(outOfRange.path, "utf8"))).length).toBeGreaterThan(0);
  });

  test("rejects an LLM prompt without the input placeholder", () => {
    const { path } = writeTampered(readProtocolFixture(), (p) => {
      p.llm_checkers.prompts.overall = p.llm_checkers.prompts.overall.replace("{input_json}", "the input");
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(path, "utf8")))).toContain(
      'llm_checkers.prompts.overall: must contain the {input_json} placeholder exactly once',
    );
  });

  test("rejects a retry policy other than exactly one retry", () => {
    const { path } = writeTampered(readProtocolFixture(), (p) => {
      p.retry_policy.max_retries = 2;
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(path, "utf8")))).toContain(
      "retry_policy.max_retries: the recorded policy is exactly 1 retry for invalid output",
    );
  });

  test("rejects a Jev question set missing a fixed ownership option", () => {
    const { path } = writeTampered(readProtocolFixture(), (p) => {
      delete (p.jev.questions.ownership.fixed_options as Record<string, unknown>)["not stated"];
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(path, "utf8"))).length).toBeGreaterThan(0);
  });

  test("rejects an empty limitations list", () => {
    const { path } = writeTampered(readProtocolFixture(), (p) => {
      p.limitations = [];
    });
    expect(validateCheckerProtocol(JSON.parse(readFileSync(path, "utf8"))).some((v) => v.includes("limitations"))).toBe(true);
  });
});

describe("protocol lock", () => {
  test("the frozen protocol matches its lock and loads", () => {
    const lock = verifyProtocolLock(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
    const protocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
    expect(lock.protocolVersion).toBe(protocol.protocol_version);
    expect(protocol.protocol_version).toBe("0.2.0");
    expect(validateCheckerProtocol(protocol)).toEqual([]);
  });

  test("refuses loudly when the protocol file no longer matches its lock", () => {
    const protocol = readProtocolFixture();
    const { dir, path } = writeTampered(protocol, (p) => {
      p.limitations = [...p.limitations, "a post-freeze edit"];
    });
    const lockPath = join(dir, "protocol.lock.json");
    const lock = JSON.parse(readFileSync(DEFAULT_PROTOCOL_LOCK_PATH, "utf8"));
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    expect(() => loadProtocol(path, lockPath)).toThrow(/no longer matches its frozen lock/);
  });
});

describe("verifyExperimentFreeze", () => {
  test("accepts the frozen case set, roster and protocol together", () => {
    const freeze = verifyExperimentFreeze({
      caseSetPath: DEFAULT_CASE_SET_PATH,
      caseSetLockPath: DEFAULT_CASE_SET_LOCK_PATH,
      rosterPath: DEFAULT_ROSTER_PATH,
      rosterLockPath: DEFAULT_ROSTER_LOCK_PATH,
      protocolPath: DEFAULT_PROTOCOL_PATH,
      protocolLockPath: DEFAULT_PROTOCOL_LOCK_PATH,
    });
    expect(freeze.protocolVersion).toBe("0.2.0");
    expect(freeze.caseSetVersion).toBe("1.0.0");
    expect(freeze.caseSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(freeze.rosterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(freeze.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses loudly when the roster no longer matches the hash bound into the protocol lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-freeze-"));
    const rosterPath = join(dir, "roster.json");
    const roster = JSON.parse(readFileSync(DEFAULT_ROSTER_PATH, "utf8"));
    roster.entries[0].name = "Tampered Name";
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

    expect(() =>
      verifyExperimentFreeze({
        caseSetPath: DEFAULT_CASE_SET_PATH,
        caseSetLockPath: DEFAULT_CASE_SET_LOCK_PATH,
        rosterPath,
        rosterLockPath: DEFAULT_ROSTER_LOCK_PATH,
        protocolPath: DEFAULT_PROTOCOL_PATH,
        protocolLockPath: DEFAULT_PROTOCOL_LOCK_PATH,
      }),
    ).toThrow(/roster/);
    expect(ProtocolValidationError).toBeDefined();
  });
});
