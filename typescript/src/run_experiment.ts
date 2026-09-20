import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROTOCOL_LOCK_PATH,
  DEFAULT_PROTOCOL_PATH,
  loadProtocol,
  verifyExperimentFreeze,
} from "./checker_protocol.ts";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH, loadRoster } from "./roster.ts";
import { allArms, runArm } from "./experiment_runner.ts";
import { apiKeyFromEnv, GatewayClient, loadDotEnvFile } from "./gateway_client.ts";

const DEFAULT_EXPERIMENT_DIR = fileURLToPath(new URL("../../fixtures/experiment_v1/", import.meta.url));
const REPO_DOT_ENV = fileURLToPath(new URL("../../.env", import.meta.url));

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function resolveApiKey(): string {
  if (process.env.AI_GATEWAY_API_KEY !== undefined && process.env.AI_GATEWAY_API_KEY.trim().length > 0) {
    return apiKeyFromEnv(process.env as Record<string, string | undefined>);
  }
  let dotenv: Record<string, string> = {};
  try {
    dotenv = loadDotEnvFile(readFileSync(REPO_DOT_ENV, "utf8"));
  } catch {
    // no .env file; the error below names the expected locations
  }
  return apiKeyFromEnv({ ...dotenv, AI_GATEWAY_API_KEY: dotenv["AI_GATEWAY_API_KEY"] ?? "" });
}

const armName = argValue("--arm");
if (armName === undefined) {
  console.error("usage: bun src/run_experiment.ts --arm <name> [--repeat N] [--out dir] [--commit sha]");
  console.error(`available arms: ${allArms(loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH)).map((a) => a.name).join(", ")}`);
  process.exit(1);
}

const commit = argValue("--commit") ?? execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

const freeze = verifyExperimentFreeze({
  caseSetPath: DEFAULT_CASE_SET_PATH,
  caseSetLockPath: DEFAULT_CASE_SET_LOCK_PATH,
  rosterPath: DEFAULT_ROSTER_PATH,
  rosterLockPath: DEFAULT_ROSTER_LOCK_PATH,
  protocolPath: DEFAULT_PROTOCOL_PATH,
  protocolLockPath: DEFAULT_PROTOCOL_LOCK_PATH,
});
const protocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);

const arm = allArms(protocol).find((a) => a.name === armName);
if (arm === undefined) {
  console.error(`unknown arm "${armName}"; available arms: ${allArms(protocol).map((a) => a.name).join(", ")}`);
  process.exit(1);
}

const defaultRepeats = arm.timingRun ? protocol.repeats.timing : protocol.repeats.scored;
const repeatArg = argValue("--repeat");
const repeatCount = repeatArg !== undefined ? Number.parseInt(repeatArg, 10) : defaultRepeats;
if (!Number.isInteger(repeatCount) || repeatCount < 1) {
  console.error("--repeat must be an integer of at least 1");
  process.exit(1);
}

const outputDir = argValue("--out") ?? `${DEFAULT_EXPERIMENT_DIR}${arm.name}`;
const networked = arm.variant !== "rules";
const client = networked ? new GatewayClient({ apiKey: resolveApiKey() }) : undefined;
const concurrencyArg = argValue("--concurrency");
const concurrency = concurrencyArg !== undefined ? Number.parseInt(concurrencyArg, 10) : 4;
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error("--concurrency must be an integer of at least 1");
  process.exit(1);
}

console.log(`Running arm ${arm.name}`);
console.log(`  checker:      ${arm.checker}${arm.modelId === null ? "" : ` (${arm.modelId})`}`);
console.log(`  protocol:     ${freeze.protocolVersion} at sha256 ${freeze.protocolSha256}`);
console.log(`  case set:     ${freeze.caseSetVersion} at sha256 ${freeze.caseSetSha256}`);
console.log(`  roster:       ${freeze.rosterVersion} at sha256 ${freeze.rosterSha256}`);
console.log(`  repeats:      ${repeatCount}${arm.timingRun ? " (verdict-only timing run, not scored)" : ""}`);
console.log(`  output:       ${outputDir}`);
if (networked) console.log("  network:      Vercel AI Gateway (credentials never recorded)");

const startedAt = Date.now();
const result = await runArm({
  arm,
  caseSet,
  roster,
  protocol,
  freeze,
  commit,
  repeatCount,
  outputDir,
  client,
  concurrency,
  onProgress: (done, total) => {
    if (done % 10 === 0 || done === total) console.log(`  progress: ${done}/${total} evaluations`);
  },
});

console.log(`Recorded run ${result.runId} in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
console.log(`  records:      ${result.recordCount}`);
console.log(`  passed:       ${result.passed}`);
console.log(`  review:       ${result.reviewed}`);
console.log(`  exec errors:  ${result.executionErrors}`);
console.log(`  input errors: ${result.inputPreparationErrors}`);
