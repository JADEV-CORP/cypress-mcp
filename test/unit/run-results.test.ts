import { describe, it, expect } from "vitest";
import type { CypressRunResult } from "../../src/types/results.js";
import { enrichRunResult } from "../../src/utils/run-results.js";

const baseResult: CypressRunResult = {
  success: false,
  stats: {
    tests: 1,
    passing: 0,
    failing: 1,
    pending: 0,
    skipped: 0,
    flaky: 0,
    duration: 1000,
  },
  tests: [],
  failures: [
    {
      title: "should log in",
      fullTitle: "Login flow should log in",
      error: "Expected login to succeed",
      stack: "",
    },
  ],
  screenshots: [],
  videos: [],
};

describe("run-results helpers", () => {
  it("should attach matching screenshots to failures", () => {
    const enriched = enrichRunResult(baseResult, [
      "C:/tmp/Login flow -- should log in (failed).png",
    ]);

    expect(enriched.failures[0]?.screenshot).toContain("should log in");
    expect(enriched.screenshots).toHaveLength(1);
  });
});
