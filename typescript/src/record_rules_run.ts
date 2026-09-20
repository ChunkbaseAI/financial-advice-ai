import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";
import { verifyCaseSetLock } from "./case_set_lock.ts";
import { buildPromptSet, promptSetSha256, runRulesChecker } from "./rules_checker.ts";
import { RunRecorder } from "./run_recorder.ts";

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("../../fixtures/rules_run_v1/", import.meta.url));

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const commit = argValue("--commit") ?? execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const repeatCount = Number.parseInt(argValue("--repeat") ?? "1", 10);
if (!Number.isInteger(repeatCount) || repeatCount < 1) {
  console.error("--repeat must be an integer of at least 1");
  process.exit(1);
}
const outputDir = argValue("--out") ?? DEFAULT_OUTPUT_DIR;

const lock = verifyCaseSetLock(DEFAULT_CASE_SET_PATH, DEFAULT_CASE_SET_LOCK_PATH);
const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const prompts = buildPromptSet(caseSet);
const frozenPromptSetSha256 = promptSetSha256(prompts);
const results = runRulesChecker(caseSet);

const runDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const runId = `rules-${runDate}-${commit.slice(0, 7)}`;

const recorder = new RunRecorder({
  runId,
  caseSetVersion: lock.caseSetVersion,
  caseSetSha256: lock.sha256,
  codeCommit: commit,
  promptSetSha256: frozenPromptSetSha256,
  repeatCount,
  checkers: ["rules"],
  outputDir,
});

for (const result of results) {
  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    recorder.recordDeterministicResult({
      sampleIndex: result.sampleIndex,
      repeatIndex,
      cardId: result.cardId,
      promptHash: result.promptHash,
      checker: "rules",
      verdict: result.verdict,
      rawAnswer: result.rawAnswer,
    });
  }
}

const supported = results.filter((r) => r.verdict === "supported").length;
console.log(`Recorded rules run ${runId}`);
console.log(`  checker:      rules (deterministic, offline, no credentials)`);
console.log(`  case set:     ${lock.caseSetVersion} at sha256 ${lock.sha256}`);
console.log(`  prompt set:   sha256 ${frozenPromptSetSha256}`);
console.log(`  records:      ${recorder.recordCount} (${results.length} cards x ${repeatCount} repeat(s))`);
console.log(`  verdicts:     ${supported} supported, ${results.length - supported} unsupported`);
console.log(`  manifest:     ${recorder.manifestPath}`);
console.log(`  records file: ${recorder.recordsPath}`);
