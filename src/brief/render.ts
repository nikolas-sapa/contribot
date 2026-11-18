import type { RepoRef } from "../types.js";
import type { AiPolicy } from "./aipolicy.js";
import type { RepoMap } from "./analyze.js";
import type { ContributionRules } from "./rules.js";
import type { MaintainerSignals } from "./signals.js";

export type Brief = {
  ref: RepoRef;
  generatedAt: string;
  map: RepoMap;
  rules: ContributionRules;
  aiPolicy: AiPolicy;
  signals: MaintainerSignals;
};

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

export function renderBrief(b: Brief): string {
  const { map, rules, aiPolicy, signals } = b;
  const L: string[] = [];
  L.push(`# AGENT-BRIEF — ${b.ref.full}`);
  L.push(`Generated ${b.generatedAt} by contribot. Read before contributing.`);
  L.push("");
  L.push("## Project map");
  L.push(`- Languages: ${map.languages.map((l) => `${l.name} ${l.pct}%`).join(", ") || "n/a"}`);
  L.push(`- Layout: ${map.topLevel.join("  ")}`);
  if (map.entryPoints.length) L.push(`- Entry points: ${map.entryPoints.join(" ; ")}`);
  L.push(`- Test setup: ${map.testSetup.runner ?? "unknown"}${map.testSetup.command ? ` — run \`${map.testSetup.command}\`` : ""}`);
  if (map.ciChecks.length) {
    L.push("- CI checks (.github/workflows):");
    for (const c of map.ciChecks) {
      L.push(`  - ${c.name} (${c.file}): jobs [${c.jobs.join(", ")}]`);
      for (const cmd of c.commands.slice(0, 8)) L.push(`    - \`${cmd}\``);
    }
  } else {
    L.push("- CI checks: none found");
  }
  L.push(`- Lint/format configs: ${map.lintConfigs.join(", ") || "none found"}`);
  L.push("");

  L.push("## Contribution rules (extracted)");
  L.push(`- DCO sign-off required: ${rules.requiresDCO ? "YES" : "no"}; CLA: ${rules.requiresCLA ? "YES" : "no"}; conventional commits: ${rules.conventionalCommits ? "likely" : "not stated"}`);
  L.push(`- Tests required with PR: ${rules.testsRequired ? "yes" : "not stated"}; issue required first: ${rules.issueRequired ? "yes" : "not stated"}`);
  if (rules.items.length) {
    for (const r of rules.items) L.push(`- [${r.id}] ${r.text} _(${r.source})_`);
  } else {
    L.push("- No CONTRIBUTING.md found — minimal external evidence. Default to conservative behavior.");
  }
  if (map.files.issueTemplates.length) {
    L.push(`- Issue templates: ${map.files.issueTemplates.join(", ")}`);
  }
  L.push("");

  L.push("## Maintainer signals");
  L.push(`- Recent closed PRs sampled: ${signals.sampledClosedPrs}; merge rate: ${pct(signals.mergeRate)}`);
  L.push(`- Median time-to-first-maintainer-reply on external PRs: ${signals.medianHoursToFirstReply ?? "n/a"}h`);
  L.push(`- Maintainers merge external PRs: ${signals.externalPrsAnswered === null ? "n/a" : signals.externalPrsAnswered ? "yes" : "no evidence"}`);
  L.push(`- Open "good first issue": ${signals.goodFirstIssueCount ?? "n/a"}; "help wanted": ${signals.helpWantedCount ?? "n/a"}`);
  for (const n of signals.notes) L.push(`- note: ${n}`);
  L.push("");

  L.push("## AI policy");
  L.push(`- Verdict: **${aiPolicy.verdict.toUpperCase()}**`);
  for (const e of aiPolicy.evidence) L.push(`- ${e}`);
  if (aiPolicy.verdict === "banned") {
    L.push("- ⛔ This project bans AI contributions. contribot will HARD-STOP any `pr` attempt. Do not override.");
  } else {
    L.push("- Regardless of verdict, every contribot PR carries a non-removable AI-assistance disclosure line.");
  }
  L.push("");

  L.push("## Conventions");
  L.push(`- Conventional-commit ratio in recent history: ${pct(map.conventions.conventionalCommitRatio)}`);
  L.push(`- Sign-off (Signed-off-by) ratio: ${pct(map.conventions.signoffRatio)}`);
  for (const s of map.conventions.sampleSubjects) L.push(`  - ${s}`);
  if (map.files.dependabot || map.files.renovate) {
    L.push(`- ⚠ Dependency bot detected (${map.files.dependabot ? "dependabot" : ""}${map.files.dependabot && map.files.renovate ? " + " : ""}${map.files.renovate ? "renovate" : ""}) — dependency-bump contributions are rejected.`);
  }
  L.push("");
  L.push("## Suggested local verification commands");
  const cmds = new Set<string>();
  if (map.testSetup.command) cmds.add(map.testSetup.command.replace(/\s*\(.+\)$/, ""));
  for (const c of map.ciChecks) {
    for (const cmd of c.commands) {
      if (/^(npm|yarn|pnpm|make|pytest|go test|cargo|ruff|eslint|flake8|tsc|npx)/.test(cmd) && cmd.length < 80) {
        cmds.add(cmd);
      }
    }
  }
  for (const c of [...cmds].slice(0, 10)) L.push(`- \`${c}\``);
  L.push("");
  return L.join("\n");
}
