import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { RepoRef } from "../types.js";

export type Workspace = {
  dir: string;
  branch: string;
  baseRef: string;
};

export function branchName(issueNumber: number | null, slug: string): string {
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "fix";
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

  await git.remote(["add", "upstream", `https://github.com/${ref.full}.git`]).catch(async () => {
    await git.remote(["set-url", "upstream", `https://github.com/${ref.full}.git`]).catch(() => {});
  });
  await git.fetch(["upstream", "--depth", "20"]);

  let baseRef = "upstream/main";
  try {
    await git.raw(["remote", "set-head", "upstream", "-a"]);
    const head = (await git.raw(["rev-parse", "--abbrev-ref", "upstream/HEAD"])).trim();
    if (head) baseRef = head;
  } catch {
    const symref = await git.raw(["ls-remote", "--symref", "upstream", "HEAD"]).catch(() => "");
    const m = symref.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
    if (m) baseRef = `upstream/${m[1]}`;
  }

  await git.checkout(["-B", branch, baseRef]);
  await git.reset(["--hard", baseRef]);
  await git.raw(["clean", "-fd"]);
  return { dir, branch, baseRef };
}

export async function applyPatch(dir: string, patchFile: string): Promise<void> {
  const abs = resolve(patchFile);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`patch file not found: ${patchFile}`);
  if (abs.startsWith(dir + "/")) throw new Error("patch file must live outside the contribot workspace");
  const git = simpleGit(dir);
  const patch = readFileSync(abs, "utf8");
  if (!patch.trim()) throw new Error("patch file is empty");
  try {
    await git.raw(["apply", "--check", abs]);
  } catch (e) {
    throw new Error(`patch does not apply cleanly: ${(e as Error).message.split("\n")[0]}`);
  }
  await git.raw(["apply", abs]);
}

export async function diffLineCount(dir: string): Promise<number> {
  const git = simpleGit(dir);
  await git.raw(["add", "-A", "."]);
  const out = await git.raw(["diff", "--cached", "--numstat"]);
  let lines = 0;
  for (const l of out.split("\n")) {
    const [a, d] = l.split("\t");
    lines += (parseInt(a) || 0) + (parseInt(d) || 0);
  }
  return lines;
}

export async function commitAll(
  dir: string,
  message: string,
  opts: { signoff?: boolean } = {},
): Promise<void> {
  const git = simpleGit(dir);
  await git.add(["-A", "."]);
  const status = await git.status();
  if (status.staged.length === 0) {
    throw new Error("patch produced no changes — nothing to commit");
  }
  const args = ["commit", "-m", message];
  if (opts.signoff) args.push("--signoff");
  await git.raw(args);
}
