import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "./analyze.js";

export type ContributionRule = { id: string; text: string; source: string };

export type ContributionRules = {
  items: ContributionRule[];
  requiresDCO: boolean;
  requiresCLA: boolean;
  conventionalCommits: boolean;
  testsRequired: boolean;
  issueRequired: boolean;
};

const ACTIONABLE = /\b(must|should|shall|need to|required|require|ensure|make sure|always|never|do not|don't|sign[- ]?off|DCO|CLA|conventional|test|lint|format|issue|pull request|PR|branch|commit)\b/i;

export function extractRules(root: string, map: RepoMap): ContributionRules {
  const rules: ContributionRules = {
    items: [],
    requiresDCO: false,
    requiresCLA: false,
    conventionalCommits: false,
    testsRequired: false,
    issueRequired: false,
  };
  const sources: [string | null, string][] = [
    [map.files.contributing, "CONTRIBUTING"],
    [map.files.prTemplate?.endsWith("/") ? null : map.files.prTemplate, "PR template"],
    [map.files.cla, "CLA/DCO doc"],
  ];
  let idx = 0;
  for (const [file, label] of sources) {
    if (!file) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (/\b(CLA|contributor license agreement)\b/i.test(text)) rules.requiresCLA = true;
    if (/\b(DCO|sign[- ]?off|signed-off-by)\b/i.test(text)) rules.requiresDCO = true;
    if (/\bconventional commits?\b/i.test(text)) rules.conventionalCommits = true;
    for (const line of text.split("\n")) {
      const t = line.replace(/^[\s#>*\-+]+/, "").trim();
      if (t.length < 15 || t.length > 300 || t.startsWith("http") || /^\[.+\]:/.test(t)) continue;
      if (!ACTIONABLE.test(t)) continue;
      rules.items.push({ id: `R${++idx}`, text: t, source: `${label} (${file})` });
      if (/\b(tests?|specs?)\b.*\b(pass|run|add|include|require|must)/i.test(t) || /\brequire|must|add\b.*\btests?\b/i.test(t)) {
        rules.testsRequired = true;
      }
      if (/\b(open|file|create|find|link|reference)\b.*\bissue\b|\bissue\b.*\b(first|before|required)/i.test(t)) {
        rules.issueRequired = true;
      }
    }
  }
  if (rules.items.length > 40) rules.items = rules.items.slice(0, 40);
  return rules;
}
