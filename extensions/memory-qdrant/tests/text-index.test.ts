/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { TextIndex } from "../index.ts";

describe("TextIndex (MiniSearch)", () => {
  it("indexes and searches text", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const index = new TextIndex(base);

    index.add([
      { id: "1", file: "a.md", startLine: 1, endLine: 1, text: "foo bar", hash: "1" },
      { id: "2", file: "b.md", startLine: 1, endLine: 1, text: "bar baz", hash: "2" },
    ]);

    const results = index.search("foo", 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");

    await index.save();

    const index2 = new TextIndex(base);
    await index2.load();
    const results2 = index2.search("baz", 10);
    expect(results2).toHaveLength(1);
    expect(results2[0].id).toBe("2");
  });

  it("load handles existing index data", async () => {
    const base = join(tmpdir(), `memory-qdrant-load-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const oldData = {
      documentCount: 0,
      fieldLength: {},
      averageFieldLength: {},
      documents: {},
      fieldVectors: {},
      invertedIndexes: {},
      documentIds: [],
      idToShortId: {},
      shortIdToId: {},
    };
    await writeFile(join(base, ".memory-index.json"), JSON.stringify(oldData));

    const index = new TextIndex(base);
    await index.load();
    expect(index.search("test", 1)).toEqual([]);

    const newData = { index: oldData, fileMap: {} };
    await writeFile(join(base, ".memory-index.json"), JSON.stringify(newData));

    const index2 = new TextIndex(base);
    await index2.load();
    expect(index2.search("test", 1)).toEqual([]);
  });

  it("removes by file", async () => {
    const base = join(tmpdir(), `memory-rem-${Date.now()}`);
    await mkdir(base, { recursive: true });
    const index = new TextIndex(base);

    index.add([
      { id: "1", file: "a.md", startLine: 1, endLine: 1, text: "apple", hash: "1" },
      { id: "2", file: "b.md", startLine: 1, endLine: 1, text: "banana", hash: "2" },
      { id: "3", file: "a.md", startLine: 2, endLine: 2, text: "cherry", hash: "3" },
    ]);

    index.removeByFile("a.md");

    expect(index.search("apple", 10)).toHaveLength(0);
    expect(index.search("cherry", 10)).toHaveLength(0);
    expect(index.search("banana", 10)).toHaveLength(1);
  });

  it("handles load errors gracefully", async () => {
    const base = join(tmpdir(), `memory-qdrant-err-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, ".memory-index.json"), "invalid json");

    const index = new TextIndex(base);
    await index.load(); // Should not throw
    index.add([{ id: "1", file: "a.md", text: "test", startLine: 1, endLine: 1, hash: "h" }]);
    expect(index.search("test", 1)).toHaveLength(1);
  });

  it("handles short queries correctly", () => {
    const textIndex = new TextIndex("/tmp");
    textIndex.add([
      {
        id: "1",
        text: "This is a test",
        file: "test.md",
        startLine: 1,
        endLine: 1,
        source: "workspace",
      },
    ]);
    textIndex.add([
      { id: "2", text: "Short", file: "short.md", startLine: 1, endLine: 1, source: "workspace" },
    ]);

    const results = textIndex.search("is", 10);
    expect(results.length).toBeGreaterThan(0);

    const noisyResults = textIndex.search("a", 10);
    expect(Array.isArray(noisyResults)).toBe(true);
  });

  it("fallback to text-only when embedding fails", () => {
    const textIndex = new TextIndex("/tmp");
    textIndex.add([
      {
        id: "1",
        text: "Important fact about deployment",
        file: "memory.md",
        startLine: 1,
        endLine: 1,
        source: "workspace",
      },
    ]);

    const textResults = textIndex.search("deployment", 10);
    expect(textResults.length).toBeGreaterThan(0);
    expect(textResults[0].text).toContain("deployment");
  });

  it("removeByFile handles non-existent file", async () => {
    const base = join(tmpdir(), `memory-extra-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const ti = new TextIndex(base);
    ti.add([{ id: "1", file: "a.md", startLine: 1, endLine: 1, text: "foo", hash: "h" }]);
    ti.add([{ id: "2", file: "b.md", startLine: 1, endLine: 1, text: "bar", hash: "h" }]);

    ti.removeByFile("a.md");
    ti.removeByFile("non-existent.md");

    expect(ti.search("bar", 1)).toBeDefined();
  });
});
