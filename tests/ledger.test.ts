import { describe, expect, it } from "vitest";
import { tmpLedger } from "./helpers.js";

describe("T-C5: ledger records every event incl. forced overrides", () => {
  it("records and reads back all event kinds", () => {
    const { ledger } = tmpLedger();
    ledger.record("scout", "acme/widgets", null, {});
    ledger.record("plan", "acme/widgets", "#3", {});
    ledger.record("pr_opened", "acme/widgets", "#9", { url: "https://x" });
    ledger.record("override", "acme/widgets", "#9", { rule: "max-open-prs-per-repo" });
    ledger.record("refusal", "acme/widgets", null, { phase: "pr-preflight" });
    ledger.record("pr_outcome", "acme/widgets", "#9", { outcome: "merged" });

    const all = ledger.all();
    expect(all).toHaveLength(6);
    const kinds = all.map((e) => e.kind).sort();
    expect(kinds).toEqual(["override", "plan", "pr_opened", "pr_outcome", "refusal", "scout"]);

    expect(ledger.openPrCount("acme/widgets")).toBe(0);
    const stats = ledger.perRepoStats();
    expect(stats[0].repo).toBe("acme/widgets");
    expect(stats[0].merged).toBe(1);
    ledger.close();
  });

  it("counts an open PR until an outcome resolves it", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "acme/widgets", "#9", {});
    expect(ledger.openPrCount("acme/widgets")).toBe(1);
    expect(ledger.prsOpenedSince(new Date(Date.now() - 86.4e6).toISOString())).toBe(1);
    ledger.record("pr_outcome", "acme/widgets", "#9", { outcome: "rejected" });
    expect(ledger.openPrCount("acme/widgets")).toBe(0);
    expect(ledger.lastOutcome("acme/widgets")?.detail).toContain("rejected");
    ledger.close();
  });
});
