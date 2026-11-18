import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoMap } from "./analyze.js";

export type AiPolicy = {
  verdict: "banned" | "welcomed" | "unmentioned" | "ambiguous";
  evidence: string[];
};

const AI_TERM = /\b(ai|artificial intelligence|llms?|large language models?|chatgpt|openai|copilot|codex|claude|gemini|machine[- ]generated|ai[- ]generated|gpt[- ]?\w*)\b/i;
const NEGATIVE = /\b(do not|don't|does not|doesn't|not accept(?:ed)?|no(?:t)?\b.{0,20}\b(?:ai|llm)s?|prohibit|ban(?:ned|ning)?|forbidden|not allowed|refus|reject|disallow|cannot|can't|won't)\b/i;
const NEGATED_POSITIVE = /\b(?:not|isn't|aren't|never|cannot|can't|won't|n't)\b[^.!?;]{0,40}\b(?:permitted|allowed|welcome[sd]?|acceptable|okay|ok|fine|encouraged?)\b/i;
const DOUBLE_NEGATIVE = /\b(?:not|no|never|n't)\b[^.!?;]{0,25}\b(?:against|prohibit\w*|ban\w*|restrict\w*|forbid\w*|disallow\w*)\b/i;
const POSITIVE = /\b(welcome|welcomed|allowed|permitted|encourage|okay|ok to use|fine with|acceptable|may use|disclos)\b/i;
const NULL_CONTEXT = /\bno\b[^.!?;]{0,25}\b(?:policy|restrictions?|rules?|issues?|problems?|objections?)\b/i;

export function detectAiPolicyText(files: { path: string; text: string }[]): AiPolicy {
  const evidence: string[] = [];
  let neg = 0;
  let pos = 0;
  for (const { path: rel, text } of files) {
    for (const line of text.split("\n")) {
      if (!AI_TERM.test(line)) continue;
      const t = line.trim();
      let isNeg = (NEGATIVE.test(t) || NEGATED_POSITIVE.test(t)) && !DOUBLE_NEGATIVE.test(t) && !NULL_CONTEXT.test(t);
      const isPos = POSITIVE.test(t) && !isNeg && !NEGATED_POSITIVE.test(t);
      if (isNeg) neg++;
      if (isPos) pos++;
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
    "Readme.md",
    "README.txt",
    "README",
    map.files.prTemplate?.endsWith("/") ? null : map.files.prTemplate,
  ].filter((f): f is string => Boolean(f));
  const files = [...new Set(candidates)]
    .map((rel) => join(root, rel))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p.slice(root.length + 1), text: readFileSync(p, "utf8") }));
  return detectAiPolicyText(files);
}
