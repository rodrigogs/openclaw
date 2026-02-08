/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { chunkText, truncateSnippet } from "../index.ts";

describe("chunkText", () => {
  it("handles empty text", () => {
    const chunks = chunkText("");
    expect(chunks).toHaveLength(0);
  });

  it("handles whitespace-only text", () => {
    const chunks = chunkText("   \n\n  \t  ");
    expect(chunks).toHaveLength(0);
  });

  it("creates single chunk for short text", () => {
    const text = "This is a short text.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it("creates multiple chunks for long text", () => {
    const lines = Array(100).fill("word word word word word").join("\n");
    const chunks = chunkText(lines, 400, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves line numbers correctly", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const chunks = chunkText(text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  it("creates overlap chunks", () => {
    const text = Array(50).fill("word word word").join("\n");
    const chunks = chunkText(text, 30, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
  });

  it("splits very long lines", () => {
    const longLine = "a".repeat(5000);
    const chunks = chunkText(longLine);
    expect(chunks).toHaveLength(1);
    const lines = chunks[0].text.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 2000)).toBe(true);
  });

  it("handles single word", () => {
    const chunks = chunkText("word");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("word");
  });
});

describe("truncateSnippet", () => {
  it("returns short text unchanged", () => {
    const text = "Short text";
    expect(truncateSnippet(text)).toBe(text);
  });

  it("truncates long text with ellipsis", () => {
    const text = "a".repeat(800);
    const result = truncateSnippet(text);
    expect(result.length).toBe(703);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns short text unchanged (custom maxLen)", () => {
    const short = "Short text";
    expect(truncateSnippet(short, 700)).toBe(short);
  });

  it("truncates long text (custom maxLen)", () => {
    const long = "a".repeat(1000);
    const result = truncateSnippet(long, 700);
    expect(result.length).toBe(703); // 700 + "..."
    expect(result.endsWith("...")).toBe(true);
  });
});
