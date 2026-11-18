import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "./analyze.js";

export type AiPolicy = {
  verdict: "banned" | "welcomed" | "unmentioned" | "ambiguous";
  evidence: string[];
};

const AI_TERM = /\b(ai|artificial intelligence|llm|large language model|chatgpt|openai|copilot|codex|claude|gemini|machine[- ]generated|ai[- ]generated|gpt[- ]?\w*)\b/i;
const NEGATIVE = /\b(do not|don't|does not|not accept|no(?:t)?\b.{0,20}\b(?:ai|llm)|prohibit|ban(?:ned)?|forbidden|not allowed|refus|reject|disallow|against)/i;
const POSITIVE = /\b(welcome|welcomed|allowed|permitted|encourage|okay|ok to use|fine with|acceptable|may use|disclos)/i;

export function detectAiPolicyText(files: { path: string; text: string }[]): AiPolicy {
  const evidence: string[] = [];
  let neg = 0;
  let pos = 0;
  for (const { path: rel, text } of files) {
    for (const line of text.split("\n")) {
      if (!AI_TERM.test(line)) continue;
      const t = line.trim();
      if (t.length > 400) continue;
      const isNeg = NEGATIVE.test(t);
      const isPos = POSITIVE.test(t);
      if (isNeg) neg++;
      if (isPos && !isNeg) pos++;
      evidence.push(`${rel}: ${t.slice(0, 200)}`);
    }
  }

  let verdict: AiPolicy["verdict"];
  if (neg > 0 && pos === 0) verdict = "banned";
  else if (neg > 0 && pos > 0) verdict = "ambiguous";
  else if (pos > 0) verdict = "welcomed";
  else if (evidence.length > 0) verdict = "ambiguous";
  else verdict = "unmentioned";
  return { verdict, evidence: evidence.slice(0, 12) };
}

export function detectAiPolicy(root: string, map: RepoMap): AiPolicy {
  const candidates = [
    map.files.contributing,
    map.files.codeOfConduct,
    "README.md",
    "readme.md",
    "README",
    map.files.prTemplate?.endsWith("/") ? null : map.files.prTemplate,
  ].filter((f): f is string => Boolean(f));
  const files = [...new Set(candidates)]
    .map((rel) => join(root, rel))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p.slice(root.length + 1), text: readFileSync(p, "utf8") }));
  return detectAiPolicyText(files);
}
