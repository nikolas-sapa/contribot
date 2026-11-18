import { describe, expect, it } from "vitest";
import { scoreCandidate } from "../src/tasks/discover.js";
import type { MaintainerSignals } from "../src/brief/signals.js";

const baseSignals: MaintainerSignals = {
  sampledClosedPrs: 20,
  mergeRate: null,
  medianHoursToFirstReply: null,
  externalPrsAnswered: null,
  goodFirstIssueCount: 0,
  helpWantedCount: 0,
  notes: [],
};

function cand(overrides: Partial<Parameters<typeof scoreCandidate>[0]> = {}) {
  return {
    ref: { owner: "o", repo: "r", full: "o/r" },
    stars: 1000,
    language: "TypeScript",
    description: null,
    goodFirstIssues: 0,
    helpWanted: 0,
    signals: baseSignals,
    aiPolicy: null,
    ...overrides,
  } as Parameters<typeof scoreCandidate>[0];
}

describe("discover scoring", () => {
  it("AI-banned repo sinks to the bottom regardless of other signals", () => {
    const s = scoreCandidate(
      cand({
        stars: 90000,
        goodFirstIssues: 10,
        aiPolicy: "banned",
        signals: { ...baseSignals, mergeRate: 0.9, externalPrsAnswered: true, medianHoursToFirstReply: 4 },
      }),
    );
    expect(s.score).toBeLessThan(0);
    expect(s.reasons[0]).toMatch(/BANNED/);
  });

  it("high merge-rate responsive repo outranks a hostile one", () => {
    const good = scoreCandidate(
      cand({
        goodFirstIssues: 5,
        signals: { ...baseSignals, mergeRate: 0.8, externalPrsAnswered: true, medianHoursToFirstReply: 12 },
      }),
    );
    const bad = scoreCandidate(
      cand({ signals: { ...baseSignals, mergeRate: 0.05, externalPrsAnswered: false } }),
    );
    expect(good.score).toBeGreaterThan(bad.score);
  });
});
