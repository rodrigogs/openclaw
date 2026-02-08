/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddings } from "../index.ts";

describe("OllamaEmbeddings", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates embeddings", async () => {
    const mockEmbedding = Array(768).fill(0.1);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: mockEmbedding }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const result = await embeddings.embed("test text");

    expect(result).toHaveLength(768);
  });

  it("embedBatch uses bulk /api/embed endpoint", async () => {
    const mockEmbeddingA = [0.1, 0.2];
    const mockEmbeddingB = [0.3, 0.4];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [mockEmbeddingA, mockEmbeddingB] }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const result = await embeddings.embedBatch(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(mockEmbeddingA);
    expect(result[1]).toEqual(mockEmbeddingB);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/embed");
    const body = JSON.parse(opts.body);
    expect(body.input).toEqual(["a", "b"]);
  });

  it("embedBatch falls back to sequential on bulk endpoint failure", async () => {
    const mockEmbedding = [0.1, 0.2];
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const result = await embeddings.embedBatch(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("embedBatch handles single text without bulk endpoint", async () => {
    const mockEmbedding = [0.1, 0.2];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const result = await embeddings.embedBatch(["single"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mockEmbedding);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("embedBatch returns empty array for empty input", async () => {
    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const result = await embeddings.embedBatch([]);
    expect(result).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("getDimensions uses embed and caches", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    const dims1 = await embeddings.getDimensions();
    expect(dims1).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const dims2 = await embeddings.getDimensions();
    expect(dims2).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    await expect(embeddings.embed("x")).rejects.toThrow();
  });

  it("healthCheck succeeds when model is available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen3-embedding:4b" }, { name: "other-model" }] }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    await expect(embeddings.healthCheck()).resolves.toBeUndefined();
  });

  it("healthCheck fails when Ollama is unreachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
    await expect(embeddings.healthCheck()).rejects.toThrow("health check failed");
  });

  it("healthCheck fails when model is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "other-model" }] }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "missing-model");
    await expect(embeddings.healthCheck()).rejects.toThrow("not found");
  });
});
