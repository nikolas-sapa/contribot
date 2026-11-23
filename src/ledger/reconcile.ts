import { ghJson } from "../github.js";
import type { Ledger } from "./db.js";

export type PrState = { state: string; merged_at: string | null };
export type FetchPr = (repo: string, n: number) => Promise<PrState>;

const fetchPrFromGitHub: FetchPr = async (repo, n) => (await ghJson(`/repos/${repo}/pulls/${n}`)) as PrState;

export async function reconcileRepo(ledger: Ledger, repo: string, fetchPr: FetchPr = fetchPrFromGitHub): Promise<number> {
  let resolved = 0;
  for (const prRef of ledger.unresolvedOpenedRefs(repo)) {
    const n = parseInt(prRef.replace(/\D/g, ""), 10);
    if (!Number.isFinite(n)) continue;
    try {
      const pr = await fetchPr(repo, n);
      if (pr.state === "closed") {
        ledger.record("pr_outcome", repo, prRef, { outcome: pr.merged_at ? "merged" : "closed" });
        resolved++;
      }
    } catch {
      /* unreachable API — leave unresolved */
    }
  }
  return resolved;
}

export async function reconcileAll(ledger: Ledger, fetchPr: FetchPr = fetchPrFromGitHub): Promise<number> {
  let resolved = 0;
  for (const repo of ledger.reposWithUnresolvedPrs()) {
    resolved += await reconcileRepo(ledger, repo, fetchPr);
  }
  return resolved;
}
