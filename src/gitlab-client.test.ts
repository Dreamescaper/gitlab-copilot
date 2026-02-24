import { describe, it, expect } from "vitest";
import { parseDiffLines, computeOldLine } from "./gitlab-client.js";

describe("parseDiffLines", () => {
  it("returns empty map for empty diff", () => {
    expect(parseDiffLines("")).toEqual(new Map());
  });

  it("parses added lines with oldLine = null", () => {
    const diff = [
      "@@ -10,3 +10,5 @@ some context",
      " unchanged line",
      "+added line 1",
      "+added line 2",
      " another unchanged",
    ].join("\n");

    const result = parseDiffLines(diff);

    // Line 11 = added → oldLine null
    expect(result.get(11)).toEqual({ newLine: 11, oldLine: null });
    // Line 12 = added → oldLine null
    expect(result.get(12)).toEqual({ newLine: 12, oldLine: null });
  });

  it("parses context lines with both oldLine and newLine", () => {
    const diff = [
      "@@ -10,3 +10,3 @@ some context",
      " context line A",
      " context line B",
      " context line C",
    ].join("\n");

    const result = parseDiffLines(diff);

    // All context lines: old and new sides advance in lockstep
    expect(result.get(10)).toEqual({ newLine: 10, oldLine: 10 });
    expect(result.get(11)).toEqual({ newLine: 11, oldLine: 11 });
    expect(result.get(12)).toEqual({ newLine: 12, oldLine: 12 });
  });

  it("handles removed lines — skips old side, does not add to map", () => {
    const diff = [
      "@@ -10,4 +10,2 @@ heading",
      " context before",
      "-removed line 1",
      "-removed line 2",
      " context after",
    ].join("\n");

    const result = parseDiffLines(diff);

    // context before: new=10, old=10
    expect(result.get(10)).toEqual({ newLine: 10, oldLine: 10 });
    // Two removed lines consume old 11 and 12 but produce no new lines
    // context after: new=11, old=13
    expect(result.get(11)).toEqual({ newLine: 11, oldLine: 13 });
    // No new lines 12+ in this hunk
    expect(result.has(12)).toBe(false);
  });

  it("tracks old/new line divergence after removed + added lines", () => {
    // Simulates a replacement: 2 lines removed, 3 lines added
    const diff = [
      "@@ -100,5 +100,6 @@ function example() {",
      " context start",
      "-old implementation line 1",
      "-old implementation line 2",
      "+new implementation line 1",
      "+new implementation line 2",
      "+new implementation line 3",
      " context end",
    ].join("\n");

    const result = parseDiffLines(diff);

    // context start: new=100, old=100
    expect(result.get(100)).toEqual({ newLine: 100, oldLine: 100 });
    // 2 removed lines: old advances to 102 → 103 (consumes old 101, 102)
    // 3 added lines: new=101,102,103 — all with oldLine null
    expect(result.get(101)).toEqual({ newLine: 101, oldLine: null });
    expect(result.get(102)).toEqual({ newLine: 102, oldLine: null });
    expect(result.get(103)).toEqual({ newLine: 103, oldLine: null });
    // context end: new=104, old=103
    expect(result.get(104)).toEqual({ newLine: 104, oldLine: 103 });
  });

  it("handles multiple hunks independently", () => {
    const diff = [
      "@@ -5,3 +5,3 @@ first section",
      " ctx A",
      " ctx B",
      " ctx C",
      "@@ -50,3 +50,4 @@ second section",
      " ctx D",
      "+new line in second hunk",
      " ctx E",
      " ctx F",
    ].join("\n");

    const result = parseDiffLines(diff);

    // First hunk: context lines 5-7
    expect(result.get(5)).toEqual({ newLine: 5, oldLine: 5 });
    expect(result.get(7)).toEqual({ newLine: 7, oldLine: 7 });

    // Second hunk: starts at new=50, old=50
    expect(result.get(50)).toEqual({ newLine: 50, oldLine: 50 });
    // added line: new=51, old=null
    expect(result.get(51)).toEqual({ newLine: 51, oldLine: null });
    // ctx E: new=52, old=51 (old didn't advance past added)
    expect(result.get(52)).toEqual({ newLine: 52, oldLine: 51 });
    // ctx F: new=53, old=52
    expect(result.get(53)).toEqual({ newLine: 53, oldLine: 52 });
  });

  it("handles hunk headers with single-line counts (@@ -N +M @@)", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-old single line",
      "+new single line",
    ].join("\n");

    const result = parseDiffLines(diff);

    // added line at new=1
    expect(result.get(1)).toEqual({ newLine: 1, oldLine: null });
  });

  it("reproduces the real-world OesOrderManagementStack.cs scenario", () => {
    // Simulates: context lines where new_line differs from old_line
    // because earlier in the file lines were removed.
    // E.g. old line 633 maps to new line 631 (2 lines removed earlier)
    const diff = [
      "@@ -630,7 +628,7 @@ class OesOrderManagementStack",
      " context line 1",
      " context line 2",
      " context line 3",    // new=630, old=632
      " target context line", // new=631, old=633 — the key case!
      " context line 5",
      " context line 6",
      " context line 7",
    ].join("\n");

    const result = parseDiffLines(diff);

    // The target line: new=631, old=633
    const lineInfo = result.get(631);
    expect(lineInfo).toBeDefined();
    expect(lineInfo!.newLine).toBe(631);
    expect(lineInfo!.oldLine).toBe(633);
    // This is what GitLab needs to compute line_code: "{hash}_633_631"
  });

  it("reproduces the appsettings.prod.json scenario — added lines work", () => {
    // Lines that are purely added (no old side) — these already worked
    const diff = [
      "@@ -22,5 +22,5 @@",
      " existing line 1",
      " existing line 2",
      "-old url value",
      "+new url value",    // new=24, old=null (added)
      " existing line 3",
      " existing line 4",
    ].join("\n");

    const result = parseDiffLines(diff);

    // Context lines
    expect(result.get(22)).toEqual({ newLine: 22, oldLine: 22 });
    expect(result.get(23)).toEqual({ newLine: 23, oldLine: 23 });
    // Replaced line: the + line is "added" → oldLine null
    expect(result.get(24)).toEqual({ newLine: 24, oldLine: null });
    // Context after: old consumed 22,23,24(removed) → old=25; new=25
    expect(result.get(25)).toEqual({ newLine: 25, oldLine: 25 });
  });

  it("ignores lines before the first hunk header", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "index abc123..def456 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,3 @@",
      " first line",
      "+inserted line",
      " second line",
    ].join("\n");

    const result = parseDiffLines(diff);

    expect(result.get(1)).toEqual({ newLine: 1, oldLine: 1 });
    expect(result.get(2)).toEqual({ newLine: 2, oldLine: null });
    expect(result.get(3)).toEqual({ newLine: 3, oldLine: 2 });
  });

  it("position object for context line includes old_line", () => {
    // Integration-style test: verify the position we'd build
    const diff = [
      "@@ -630,4 +628,4 @@",
      " ctx 1",
      " ctx 2",  // new=629, old=631
      " ctx 3",  // new=630, old=632
      " ctx 4",  // new=631, old=633
    ].join("\n");

    const result = parseDiffLines(diff);
    const lineInfo = result.get(631)!;

    // Build position like postReview does
    const position: Record<string, unknown> = {
      position_type: "text",
      new_line: lineInfo.newLine,
      ...(lineInfo.oldLine !== null && { old_line: lineInfo.oldLine }),
    };

    expect(position.new_line).toBe(631);
    expect(position.old_line).toBe(633);
  });

  it("position object for added line omits old_line", () => {
    const diff = [
      "@@ -10,2 +10,3 @@",
      " context",
      "+added",
      " context after",
    ].join("\n");

    const result = parseDiffLines(diff);
    const lineInfo = result.get(11)!;

    const position: Record<string, unknown> = {
      position_type: "text",
      new_line: lineInfo.newLine,
      ...(lineInfo.oldLine !== null && { old_line: lineInfo.oldLine }),
    };

    expect(position.new_line).toBe(11);
    expect(position).not.toHaveProperty("old_line");
  });
});

describe("computeOldLine", () => {
  it("returns same line when diff is empty (no hunks)", () => {
    expect(computeOldLine("", 50)).toBe(50);
  });

  it("returns same line for lines before the first hunk", () => {
    const diff = [
      "@@ -20,3 +20,3 @@",
      " ctx",
      " ctx",
      " ctx",
    ].join("\n");

    // Line 5 is before the hunk at line 20 — no offset yet
    expect(computeOldLine(diff, 5)).toBe(5);
    expect(computeOldLine(diff, 1)).toBe(1);
  });

  it("adjusts for added lines (new side grew)", () => {
    // 3 old lines → 5 new lines = 2 lines added
    const diff = [
      "@@ -10,3 +10,5 @@",
      " ctx",
      "+added1",
      "+added2",
      " ctx",
      " ctx",
    ].join("\n");

    // After hunk: oldEnd = 10+3=13, newEnd = 10+5=15
    // offset = 13 - 15 = -2
    // Line 20 (after hunk): old = 20 + (-2) = 18
    expect(computeOldLine(diff, 20)).toBe(18);
    expect(computeOldLine(diff, 50)).toBe(48);
  });

  it("adjusts for removed lines (new side shrank)", () => {
    // 5 old lines → 3 new lines = 2 lines removed
    const diff = [
      "@@ -10,5 +10,3 @@",
      " ctx",
      "-removed1",
      "-removed2",
      " ctx",
      " ctx",
    ].join("\n");

    // After hunk: oldEnd = 10+5=15, newEnd = 10+3=13
    // offset = 15 - 13 = 2
    // Line 20 (after hunk): old = 20 + 2 = 22
    expect(computeOldLine(diff, 20)).toBe(22);
  });

  it("handles multiple hunks with cumulative offset", () => {
    const diff = [
      // Hunk 1: 2 lines added (offset after: -2)
      "@@ -10,3 +10,5 @@",
      " ctx",
      "+a",
      "+b",
      " ctx",
      " ctx",
      // Hunk 2: 1 line removed (net offset after: -2 + 1 = -1? No, recalculate)
      // Hunk 2: old starts at 20, count 4; new starts at 22, count 3
      // offset after hunk 2 = (20+4) - (22+3) = 24 - 25 = -1
      "@@ -20,4 +22,3 @@",
      " ctx",
      "-removed",
      " ctx",
      " ctx",
    ].join("\n");

    // Between hunks (line 18, after hunk 1): offset = (10+3)-(10+5) = -2
    expect(computeOldLine(diff, 18)).toBe(16);

    // After hunk 2 (line 30): offset = (20+4)-(22+3) = -1
    expect(computeOldLine(diff, 30)).toBe(29);
  });

  it("handles gap between hunks correctly", () => {
    const diff = [
      // Hunk 1: replace 2 lines with 4 (net +2, offset = -2)
      "@@ -5,4 +5,6 @@",
      " ctx",
      "-old1",
      "-old2",
      "+new1",
      "+new2",
      "+new3",
      "+new4",
      " ctx",
      " ctx",
      // Hunk 2 starts far away
      "@@ -50,3 +52,3 @@",
      " ctx",
      " ctx",
      " ctx",
    ].join("\n");

    // Line 30 is between hunks: offset from hunk 1 = (5+4)-(5+6) = -2
    expect(computeOldLine(diff, 30)).toBe(28);

    // Line 100 is after both hunks: offset from hunk 2 = (50+3)-(52+3) = -2
    expect(computeOldLine(diff, 100)).toBe(98);
  });

  it("reproduces real OesOrderManagementStack.cs scenario", () => {
    // If earlier hunks removed 2 net lines, new_line 631 → old_line 633
    const diff = [
      // Earlier hunk that removed 2 more old lines than new
      "@@ -10,7 +10,5 @@",
      " ctx",
      "-removed1",
      "-removed2",
      "-removed3",
      "-removed4",
      " ctx",
      " ctx",
      " ctx",
      " ctx",
    ].join("\n");

    // After hunk: offset = (10+7)-(10+5) = 2
    // new_line 631 → old = 631 + 2 = 633 ✓
    expect(computeOldLine(diff, 631)).toBe(633);
  });

  it("works with single-line hunk counts", () => {
    // @@ -5 +5,2 @@ means old_count=1, new_count=2
    const diff = "@@ -5 +5,2 @@\n ctx\n+added";

    // offset = (5+1)-(5+2) = -1
    expect(computeOldLine(diff, 20)).toBe(19);
  });
});
