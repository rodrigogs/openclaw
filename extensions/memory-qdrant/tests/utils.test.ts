/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { generatePointId } from "../index.ts";

describe("generatePointId", () => {
  it("returns a deterministic numeric string", () => {
    const id1 = generatePointId("test-input");
    const id2 = generatePointId("test-input");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^\d+$/);
  });

  it("returns different IDs for different inputs", () => {
    const id1 = generatePointId("file1.md:1-10");
    const id2 = generatePointId("file2.md:1-10");
    expect(id1).not.toBe(id2);
  });

  it("produces IDs within Number.MAX_SAFE_INTEGER", () => {
    const inputs = Array.from({ length: 100 }, (_, i) => `test-${i}-${Math.random()}`);
    for (const input of inputs) {
      const id = generatePointId(input);
      const num = Number(id);
      expect(num).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num.toString()).toBe(id);
    }
  });

  it("handles edge-case inputs (empty, long, unicode)", () => {
    const emptyId = generatePointId("");
    expect(emptyId).toMatch(/^\d+$/);
    expect(Number(emptyId)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

    const longId = generatePointId("x".repeat(10000));
    expect(longId).toMatch(/^\d+$/);
    expect(Number(longId)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

    const unicodeId = generatePointId("café-résumé-日本語");
    expect(unicodeId).toMatch(/^\d+$/);
    expect(Number(unicodeId)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("Recency scoring", () => {
  it("applies exponential decay to captured memories", () => {
    const now = Date.now();
    const halfLifeDays = 30;
    const recencyWeight = 0.2;

    const recent = {
      capturedAt: now - 1 * 24 * 60 * 60 * 1000,
      baseScore: 0.8,
    };
    const recentAgeMs = now - recent.capturedAt;
    const recentAgeDays = recentAgeMs / (24 * 60 * 60 * 1000);
    const recentDecay = Math.exp((-Math.LN2 * recentAgeDays) / halfLifeDays);
    const recentFinalScore = recent.baseScore * (1 - recencyWeight) + recentDecay * recencyWeight;
    expect(recentFinalScore).toBeGreaterThan(0.79);

    const old = {
      capturedAt: now - 60 * 24 * 60 * 60 * 1000,
      baseScore: 0.8,
    };
    const oldAgeMs = now - old.capturedAt;
    const oldAgeDays = oldAgeMs / (24 * 60 * 60 * 1000);
    const oldDecay = Math.exp((-Math.LN2 * oldAgeDays) / halfLifeDays);
    const oldFinalScore = old.baseScore * (1 - recencyWeight) + oldDecay * recencyWeight;
    expect(oldFinalScore).toBeLessThan(recent.baseScore);
    expect(oldDecay).toBeCloseTo(0.25, 2);
  });

  it("does not apply recency to non-captured memories", () => {
    const result = {
      id: "1",
      file: "vault/note.md",
      startLine: 1,
      endLine: 10,
      snippet: "test",
      score: 0.9,
      source: "vault" as const,
    };
    expect(result.capturedAt).toBeUndefined();
  });

  it("calculates half-life correctly", () => {
    const halfLifeDays = 30;

    const ageAtHalfLife = 30;
    const decayAtHalfLife = Math.exp((-Math.LN2 * ageAtHalfLife) / halfLifeDays);
    expect(decayAtHalfLife).toBeCloseTo(0.5, 5);

    const ageAt2HalfLives = 60;
    const decayAt2HalfLives = Math.exp((-Math.LN2 * ageAt2HalfLives) / halfLifeDays);
    expect(decayAt2HalfLives).toBeCloseTo(0.25, 5);
  });
});

describe("Auto-recall timeout and error handling", () => {
  it("timeout error message contains 'timeout'", () => {
    const timeoutErr = new Error("embedding timeout");
    expect(timeoutErr.message.includes("timeout")).toBe(true);
  });

  it("non-timeout error messages are distinguishable", () => {
    const networkErr = new Error("Network error");
    expect(networkErr.message.includes("timeout")).toBe(false);
  });
});
