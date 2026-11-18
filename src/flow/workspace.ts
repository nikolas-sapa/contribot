import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { RepoRef } from "../types.js";

export type Workspace = {
  dir: string;
  branch: string;
};

export function branchName(issueNumber: number | null, slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return issueNumber ? `contribot/issue-${issueNumber}-${clean}` : `contribot/${clean}`;
}

export async function prepareWorkspace(
  fork: { cloneUrl: string; full: string },
  ref: RepoRef,
  branch: string,
  workDir: string,
): Promise<Workspace> {
  mkdirSync(workDir, { recursive: true });
  const dir = join(workDir, `${ref.owner}__${ref.repo}`);
  const git = existsSync(join(dir, ".git"))
    ? simpleGit(dir)
    : await simpleGit().clone(fork.cloneUrl, dir, ["--depth", "20"]).then(() => simpleGit(dir));
  await git.remote(["add", "upstream", `https://github.com/${ref.full}.git`]).catch(() => {});
  await git.fetch(["upstream", "--depth", "20"]);
  const upstreamDefault = (await git.raw(["rev-parse", "--abbrev-ref", "upstream/HEAD"])).trim() || "upstream/main";
  await git.checkout(["-B", branch, upstreamDefault]);
  return { dir, branch };
}

export async function applyPatch(dir: string, patchFile: string): Promise<void> {
  const git = simpleGit(dir);
  const patch = readFileSync(patchFile, "utf8");
  if (!patch.trim()) throw new Error("patch file is empty");
  try {
    await git.raw(["apply", "--check", patchFile]);
  } catch (e) {
    throw new Error(`patch does not apply cleanly: ${(e as Error).message.split("\n")[0]}`);
  }
  await git.raw(["apply", patchFile]);
}

export async function diffLineCount(dir: string, baseRef = "HEAD"): Promise<number> {
  const git = simpleGit(dir);
  const staged = await git.raw(["diff", "--cached", "--numstat"]);
  const unstaged = await git.raw(["diff", "--numstat"]);
  let lines = 0;
  for (const out of [staged, unstaged]) {
    for (const l of out.split("\n")) {
      const [a, d] = l.split("\t");
      lines += (parseInt(a) || 0) + (parseInt(d) || 0);
    }
  }
  if (lines === 0) {
    const againstBase = await git.raw(["diff", `${baseRef}`, "--numstat"]).catch(() => "");
    for (const l of againstBase.split("\n")) {
      const [a, d] = l.split("\t");
      lines += (parseInt(a) || 0) + (parseInt(d) || 0);
    }
  }
  return lines;
}

export async function commitAll(
  dir: string,
  message: string,
  opts: { signoff?: boolean } = {},
): Promise<void> {
  const git = simpleGit(dir);
  await git.add(".");
  const args = ["commit", "-m", message];
  if (opts.signoff) args.push("--signoff");
  await git.raw(args);
}
