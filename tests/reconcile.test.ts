import { describe, expect, it } from "vitest";
import { isSlop } from "../src/ledger/db.js";
import { reconcileAll, type FetchPr } from "../src/ledger/reconcile.js";
import { tmpLedger } from "./helpers.js";

describe("ledger sync: resolves PR outcomes across all repos", () => {
  it("records merged / closed outcomes and leaves open or unreachable PRs unresolved", async () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "acme/widgets", "#1", {});
    ledger.record("pr_opened", "acme/widgets", "#2", {});
    ledger.record("pr_opened", "other/lib", "#7", {});
    ledger.record("pr_opened", "down/api", "#3", {});
    const calls: string[] = [];
    const fetchPr: FetchPr = async (repo, n) => {
      calls.push(`${repo}#${n}`);
      if (repo === "down/api") throw new Error("503");
      if (n === 1) return { state: "closed", merged_at: "2025-01-01T00:00:00Z" };
      if (n === 2) return { state: "open", merged_at: null };
      return { state: "closed", merged_at: null };
    };

    expect(await reconcileAll(ledger, fetchPr)).toBe(2);
    expect(calls.sort()).toEqual(["acme/widgets#1", "acme/widgets#2", "down/api#3", "other/lib#7"]);
    expect(ledger.openPrCount("acme/widgets")).toBe(1);
    expect(ledger.openPrCount("other/lib")).toBe(0);
    expect(ledger.openPrCount("down/api")).toBe(1);
    expect(ledger.lastOutcome("other/lib")?.detail).toContain("closed");
    expect(ledger.reposWithUnresolvedPrs().sort()).toEqual(["acme/widgets", "down/api"]);

    calls.length = 0;
    expect(await reconcileAll(ledger, fetchPr)).toBe(0);
    expect(calls.sort()).toEqual(["acme/widgets#2", "down/api#3"]);
    ledger.close();
  });

  it("slop warning fires on synced closed-unmerged PRs, not only manual rejections", async () => {
    const { ledger } = tmpLedger();
    for (const n of [1, 2, 3]) ledger.record("pr_opened", "acme/widgets", `#${n}`, {});
    await reconcileAll(ledger, async (_repo, n) => ({ state: "closed", merged_at: n === 1 ? "2025-01-01T00:00:00Z" : null }));
    const stats = ledger.perRepoStats()[0];
    expect(stats).toMatchObject({ merged: 1, closed: 2, rejected: 0 });
    expect(isSlop(stats)).toBe(true);
    expect(isSlop({ merged: 2, closed: 1, rejected: 0, stale: 0 })).toBe(false);
    expect(isSlop({ merged: 0, closed: 2, rejected: 0, stale: 0 })).toBe(false);
    ledger.close();
  });
});
