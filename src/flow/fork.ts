import { ghJson, ghUser, GitHubError } from "../github.js";
import type { RepoRef } from "../types.js";

export type ForkResult = { owner: string; repo: string; cloneUrl: string; full: string };

export async function ensureFork(ref: RepoRef): Promise<ForkResult> {
  const login = await ghUser();
  if (!login) {
    throw new Error("no GitHub auth — set GITHUB_TOKEN or run `gh auth login`");
  }
  try {
    const existing = (await ghJson(`/repos/${login}/${ref.repo}`)) as { fork: boolean; clone_url: string };
    if (existing.fork) {
      return { owner: login, repo: ref.repo, cloneUrl: existing.clone_url, full: `${login}/${ref.repo}` };
    }
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 404) throw e;
  }
  const fork = (await ghJson(`/repos/${ref.full}/forks`, { method: "POST", body: "{}" })) as {
    clone_url: string;
    full_name: string;
  };
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await ghJson(`/repos/${fork.full_name}`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("fork created but not yet available after 120s");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { owner: login, repo: ref.repo, cloneUrl: fork.clone_url, full: fork.full_name };
}
