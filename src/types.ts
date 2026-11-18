export type RepoRef = {
  owner: string;
  repo: string;
  full: string;
};

export function parseRepo(input: string): RepoRef {
  const m = input.match(/(?:github\.com[:/])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`cannot parse repo "${input}" — expected owner/repo or a GitHub URL`);
  const [, owner, repo] = m;
  return { owner, repo, full: `${owner}/${repo}` };
}
