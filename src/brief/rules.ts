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
const NEGATION = /\b(not|no|n't|never|without|don't|doesn't|do not)\b/i;

function asserted(line: string, termRe: RegExp): boolean {
  const m = line.match(termRe);
  if (!m || m.index === undefined) return false;
  const before = line.slice(Math.max(0, m.index - 30), m.index);
  return !NEGATION.test(before);
}

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
    if (map.files.cla === file) rules.requiresCLA = true;
    for (const line of text.split("\n")) {
      const t = line.replace(/^[\s#>*\-+]+/, "").trim();
      if (asserted(t, /\b(CLA|contributor license agreement)\b/i)) rules.requiresCLA = true;
      if (asserted(t, /\b(DCO|sign[- ]?off|signed-off-by)\b/i)) rules.requiresDCO = true;
      if (asserted(t, /\bconventional commits?\b/i)) rules.conventionalCommits = true;
      if (t.length < 15 || t.length > 300 || t.startsWith("http") || /^\[.+\]:/.test(t)) continue;
      if (!ACTIONABLE.test(t)) continue;
      rules.items.push({ id: `R${++idx}`, text: t, source: `${label} (${file})` });
      if (/\b(?:tests?|specs?)\b[\s\S]{0,40}\b(?:pass|run|add|include|require|must|write)\b/i.test(t) || /\b(?:require[sd]?|must|add|write|run)\b[\s\S]{0,40}\btests?\b/i.test(t)) {
        if (!NEGATION.test(t)) rules.testsRequired = true;
      }
      if (/\b(open|file|create|find|link|reference)\b[\s\S]{0,30}\bissue\b|\bissue\b[\s\S]{0,30}\b(first|before|required)\b/i.test(t)) {
        if (!NEGATION.test(t)) rules.issueRequired = true;
      }
    }
  }
  if (rules.items.length > 40) rules.items = rules.items.slice(0, 40);
  return rules;
}
