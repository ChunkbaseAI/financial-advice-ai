import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DEFAULT_PROTOCOL_LOCK_PATH,
  DEFAULT_PROTOCOL_PATH,
  loadProtocol,
  verifyExperimentFreeze,
} from "./checker_protocol.ts";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH } from "./roster.ts";
import { scoreArmRun, scoredCardsFromCaseSet } from "./scorer.ts";
import { renderResultsDocument } from "./render_results.ts";

const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../../fixtures/experiment_v1/", import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL("../../docs/checker-experiment-results.md", import.meta.url));

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const runsDir = argValue("--runs") ?? DEFAULT_RUNS_DIR;
const output = argValue("--out") ?? DEFAULT_OUTPUT;
const scorerCommit = argValue("--commit") ?? execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

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
const cards = scoredCardsFromCaseSet(caseSet);

if (!existsSync(runsDir)) {
  console.error(`no runs directory at ${runsDir}; record arms first with bun src/run_experiment.ts --arm <name>`);
  process.exit(1);
}

const runDirs = readdirSync(runsDir)
  .filter((entry) => existsSync(join(runsDir, entry, "manifest.json")))
  .sort()
  .map((entry) => join(runsDir, entry));

if (runDirs.length === 0) {
  console.error(`no run directories with a manifest under ${runsDir}`);
  process.exit(1);
}

const scoredRuns = [];
const timingRuns = [];
for (const runDir of runDirs) {
  const scored = scoreArmRun(runDir, cards);
  const protocolAccepted = scored.manifest.protocol_sha256 === freeze.protocolSha256 ||
    freeze.compatibleProtocolHashes.includes(scored.manifest.protocol_sha256);
  if (!protocolAccepted) {
    console.error(
      `run ${scored.armName} was recorded under protocol sha256 ${scored.manifest.protocol_sha256}, ` +
        `which is neither the frozen ${freeze.protocolSha256} nor a declared compatible predecessor; ` +
        "it cannot be scored into this results document",
    );
    process.exit(1);
  }
  if (scored.manifest.case_set_sha256 !== freeze.caseSetSha256) {
    console.error(`run ${scored.armName} was recorded against a different case set; it cannot be scored into this results document`);
    process.exit(1);
  }
  if (scored.timingRun) timingRuns.push(scored);
  else scoredRuns.push(scored);
}

const document = renderResultsDocument({
  scoredRuns,
  timingRuns,
  protocol,
  scorerCommit,
  caseSetCards: cards.length,
});

writeFileSync(output, document);
console.log(`Scored ${scoredRuns.length} scored arm(s) and ${timingRuns.length} timing arm(s) from ${runsDir}`);
console.log(`Results document written to ${output}`);
