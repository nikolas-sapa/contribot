import { join } from "node:path";
import { contribotDir } from "../config.js";
import type { RepoRef } from "../types.js";
import { analyzeRepo } from "./analyze.js";
import { detectAiPolicy } from "./aipolicy.js";
import { ensureClone } from "./clone.js";
import { extractRules } from "./rules.js";
import { gatherSignals } from "./signals.js";
import { renderBrief, type Brief } from "./render.js";

export async function generateBrief(
  ref: RepoRef,
  opts: { baseDir?: string; skipSignals?: boolean } = {},
): Promise<{ brief: Brief; markdown: string; cloneDir: string }> {
  const base = opts.baseDir ?? contribotDir();
  const cloneDir = await ensureClone(ref, join(base, "repos"));
  const map = await analyzeRepo(cloneDir);
  const rules = extractRules(cloneDir, map);
  const aiPolicy = detectAiPolicy(cloneDir, map);
  const signals = opts.skipSignals
    ? {
        sampledClosedPrs: 0,
        mergeRate: null,
        medianHoursToFirstReply: null,
        externalPrsAnswered: null,
        goodFirstIssueCount: null,
        helpWantedCount: null,
        notes: ["signals skipped"],
      }
    : await gatherSignals(ref);
  const brief: Brief = { ref, generatedAt: new Date().toISOString(), map, rules, aiPolicy, signals };
  return { brief, markdown: renderBrief(brief), cloneDir };
}

export { analyzeRepo } from "./analyze.js";
export { detectAiPolicy } from "./aipolicy.js";
export { extractRules } from "./rules.js";
export { renderBrief } from "./render.js";
export type { Brief } from "./render.js";
