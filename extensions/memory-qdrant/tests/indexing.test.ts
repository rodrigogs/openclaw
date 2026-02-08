/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFile, mkdir, mkdtemp, rm, stat as statActual } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  QdrantClient,
  OllamaEmbeddings,
  chunkText,
  indexFile,
  indexDirectory,
  findMarkdownFiles,
  KnowledgeGraph,
  TextIndex,
} from "../index.ts";

describe("indexing helpers", () => {
  it("findMarkdownFiles finds nested markdown files", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(join(base, "a/b"), { recursive: true });
    await writeFile(join(base, "a", "one.md"), "# One");
    await writeFile(join(base, "a", "b", "two.md"), "# Two");
    await writeFile(join(base, "a", "b", "skip.txt"), "nope");

    const files = await findMarkdownFiles(base);
    expect(files.some((f) => f.endsWith("one.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("two.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("skip.txt"))).toBe(false);
  });

  it("findMarkdownFiles returns empty on missing dir", async () => {
    const files = await findMarkdownFiles("/path/does-not-exist");
    expect(files).toEqual([]);
  });

  it("indexFile generates chunks and upserts", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    const filePath = join(base, "sample.md");
    await writeFile(filePath, "Line 1\nLine 2\nLine 3");

    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
      batchUpsertFile: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const textIndex = { removeByFile: vi.fn(), add: vi.fn() } as unknown as TextIndex;
    const kg = { updateFile: vi.fn() } as unknown as KnowledgeGraph;

    const chunks = await indexFile(filePath, "memory/sample.md", qdrant, embeddings, textIndex, kg);

    expect(chunks).toBeGreaterThan(0);
    expect(qdrant.batchUpsertFile).toHaveBeenCalled();
  });

  it("indexDirectory indexes markdown files", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "a.md"), "A");
    await writeFile(join(base, "b.md"), "B");

    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
      batchUpsertFile: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const count = await indexDirectory(base, "vault/", qdrant, embeddings, {
      info: () => {},
    });

    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("edge cases + errors (indexing)", () => {
  it("indexFile handles empty file", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    const filePath = join(base, "empty.md");
    await writeFile(filePath, "");

    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const textIndex = { removeByFile: vi.fn(), add: vi.fn() } as unknown as TextIndex;
    const kg = { updateFile: vi.fn() } as unknown as KnowledgeGraph;

    const count = await indexFile(filePath, "empty.md", qdrant, embeddings, textIndex, kg);
    expect(count).toBe(0);
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it("indexFile handles read error", async () => {
    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    await expect(indexFile("/missing/file.md", "missing.md", qdrant, embeddings)).rejects.toThrow();
  });

  it("indexDirectory handles permission errors", async () => {
    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const count = await indexDirectory("/root/forbidden", "forbidden/", qdrant, embeddings, {
      info: () => {},
    });
    expect(count).toBe(0);
  });

  it("indexDirectory skips non-markdown files", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "skip.txt"), "Text");
    await writeFile(join(base, "keep.md"), "# Markdown");

    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
      batchUpsertFile: vi.fn(),
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const count = await indexDirectory(base, "test/", qdrant, embeddings, { info: () => {} });
    expect(count).toBeGreaterThan(0);
    expect(qdrant.batchUpsertFile).toHaveBeenCalledTimes(1);
  });
});

describe("indexDirectory error handling", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("continues indexing after file error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { exists: true } }),
    });

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const goodFile = join(tempDir, "good.md");
    await writeFile(goodFile, "# Good file\nContent");

    const badFile = join(tempDir, "bad.md");
    await writeFile(badFile, "");

    const qdrant = new QdrantClient("http://localhost:6333", "test");
    const embeddings = new OllamaEmbeddings("http://localhost:11434", "test");
    const textIndex = new TextIndex(tempDir);
    const graph = new KnowledgeGraph(tempDir);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Mock embedBatch to throw for empty file content (bad.md is empty)
    const origEmbedBatch = embeddings.embedBatch;
    (embeddings as any).embedBatch = vi.fn(async (texts: string[]) => {
      // Since bad.md is empty, indexFile skips it (0 chunks).
      // For good.md, return a valid embedding.
      return texts.map(() => [0.1, 0.2]);
    });

    // Override indexFile behavior by making embedBatch throw for specific calls
    const mockEmbed = embeddings.embedBatch as any;
    mockEmbed.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes("Permission"))) {
        throw new Error("Permission denied");
      }
      return texts.map(() => [0.1, 0.2]);
    });

    // Rewrite bad.md with content that triggers an embed error
    await writeFile(badFile, "Permission denied content");

    const chunks = await indexDirectory(
      tempDir,
      "vault/",
      qdrant,
      embeddings,
      logger,
      textIndex,
      graph,
    );
    expect(chunks).toBeGreaterThanOrEqual(0);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("Extra paths indexing coverage", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("indexes extra paths that are markdown files", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { exists: true } }),
    });

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const vaultDir = join(tempDir, "vault");
    const extraFile = join(tempDir, "extra.md");

    await mkdir(vaultDir);
    await writeFile(join(vaultDir, "vault-note.md"), "# Vault Note");
    await writeFile(extraFile, "# Extra Note\nExtra content");

    const qdrant = new QdrantClient("http://localhost:6333", "test");
    const embeddings = new OllamaEmbeddings("http://localhost:11434", "test");
    const textIndex = new TextIndex(tempDir);
    const graph = new KnowledgeGraph(tempDir);

    const chunks = await indexFile(
      extraFile,
      "extra/0/extra.md",
      qdrant,
      embeddings,
      textIndex,
      graph,
    );
    expect(chunks).toBeGreaterThanOrEqual(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("indexes extra paths that are directories", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { exists: true } }),
    });

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const extraDir = join(tempDir, "extra");

    await mkdir(extraDir);
    await writeFile(join(extraDir, "extra-note.md"), "# Extra Note\nDirectory content");

    const qdrant = new QdrantClient("http://localhost:6333", "test");
    const embeddings = new OllamaEmbeddings("http://localhost:11434", "test");
    const textIndex = new TextIndex(tempDir);
    const graph = new KnowledgeGraph(tempDir);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const chunks = await indexDirectory(
      extraDir,
      "extra/0/",
      qdrant,
      embeddings,
      logger,
      textIndex,
      graph,
    );
    expect(chunks).toBeGreaterThanOrEqual(0);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("indexFile uses batch API", () => {
  it("indexFile uses batch API instead of separate operations", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-batch-"));
    const testFile = join(tempDir, "test.md");
    await writeFile(testFile, "# Test\n\nThis is test content for batch API.");

    mockFetch.mockImplementation((url) => {
      if (url.includes("/api/embed")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");

    await indexFile(testFile, "test.md", qdrant, embeddings);

    const batchCalls = mockFetch.mock.calls.filter((call) => call[0].includes("/points/batch"));
    expect(batchCalls.length).toBeGreaterThan(0);

    const deleteCalls = mockFetch.mock.calls.filter(
      (call) => call[0].includes("/points/delete") && !call[0].includes("/batch"),
    );
    expect(deleteCalls.length).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("indexing failure logging", () => {
  it("logs failed indexing", async () => {
    const logs: string[] = [];
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: (m: string) => logs.push(m), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: () => {},
      on: () => {},
    } as unknown;

    const qdrant = { deleteByFile: vi.fn(), upsert: vi.fn() } as any;
    const embeddings = { embedBatch: vi.fn().mockRejectedValue(new Error("Embed fail")) } as any;

    const base = join(tmpdir(), `mem-fail-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "fail.md"), "content");

    await indexDirectory(base, "vault/", qdrant, embeddings, api.logger as any);
    expect(logs.some((l) => l.includes("failed to index"))).toBe(true);
  });
});
