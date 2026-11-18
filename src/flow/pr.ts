import { ghJson } from "../github.js";
import { DISCLOSURE_LINE } from "../checks/types.js";
import type { RepoRef } from "../types.js";
import type { TaskCandidate } from "../checks/types.js";
import type { CiRun } from "./ci.js";

export function buildPrBody(task: TaskCandidate | null, summary: string, ci: CiRun): string {
  const L: string[] = [];
  L.push("## Problem");
  if (task?.kind === "issue" && task.issue) {
    L.push(`Closes #${task.issue.number} — ${task.issue.title}`);
  } else if (task?.kind === "defect") {
    L.push(`Detected defect: ${task.defectEvidence}`);
  } else {
    L.push("Trivial/typo-class fix (no linked issue).");
  }
  L.push("");
  L.push("## Change");
  L.push(summary || "Minimal diff addressing the above.");
  L.push("");
  L.push("## Verification");
  if (ci.commands.length) {
    for (const c of ci.commands) L.push(`- \`${c.cmd}\` → ${c.ok ? "PASS" : "FAIL"}`);
  } else {
    L.push("- No runnable checks detected in repo; change verified by review.");
  }
  L.push("");
  L.push("---");
  L.push(DISCLOSURE_LINE);
  return L.join("\n");
}

export async function openDraftPr(
  ref: RepoRef,
  opts: { base: string; branch: string; title: string; body: string; login: string },
): Promise<{ url: string; number: number }> {
  const res = (await ghJson(`/repos/${ref.full}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: opts.title,
      head: `${opts.login}:${opts.branch}`,
      base: opts.base,
      body: opts.body,
      draft: true,
      maintainer_can_modify: true,
    }),
  })) as { html_url: string; number: number };
  return { url: res.html_url, number: res.number };
}
