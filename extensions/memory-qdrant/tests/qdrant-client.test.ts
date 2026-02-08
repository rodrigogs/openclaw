/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QdrantClient } from "../index.ts";

describe("QdrantClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates collection if not exists", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { exists: false } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.ensureCollection(768);

    expect(mockFetch).toHaveBeenCalledTimes(6);

    const existsCall = mockFetch.mock.calls[0];
    expect(existsCall[0]).toContain("/collections/test-collection/exists");

    const createCall = mockFetch.mock.calls[1];
    const createBody = JSON.parse(createCall[1].body);
    expect(createBody.vectors.size).toBe(768);
    expect(createBody.vectors.distance).toBe("Cosine");
    expect(createBody.quantization_config).toEqual({
      scalar: { type: "int8", quantile: 0.99, always_ram: true },
    });

    const keywordIndexes = ["file", "category", "source"];
    for (let i = 0; i < 3; i++) {
      const indexCall = mockFetch.mock.calls[2 + i];
      const indexBody = JSON.parse(indexCall[1].body);
      expect(indexBody.field_schema).toBe("keyword");
      expect(keywordIndexes).toContain(indexBody.field_name);
    }

    const capturedAtCall = mockFetch.mock.calls[5];
    const capturedAtBody = JSON.parse(capturedAtCall[1].body);
    expect(capturedAtBody.field_name).toBe("capturedAt");
    expect(capturedAtBody.field_schema).toEqual({
      type: "integer",
      range: true,
      lookup: false,
      is_principal: true,
    });
  });

  it("ensures indexes even when collection already exists", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { exists: true } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.ensureCollection(768);

    expect(mockFetch).toHaveBeenCalledTimes(5);

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[0]).toContain("/index");
  });

  it("deleteByFile calls qdrant delete", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.deleteByFile("memory/test.md");

    expect(mockFetch).toHaveBeenCalled();
  });

  it("upsert skips empty chunks", async () => {
    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.upsert([], []);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upsert writes points", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.upsert(
      [
        {
          id: "1",
          file: "memory/a.md",
          startLine: 1,
          endLine: 2,
          text: "hello",
          hash: "h",
        },
      ],
      [[0.1, 0.2]],
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it("upsertCaptured writes captured memory", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.upsertCaptured(
      {
        id: "1",
        text: "prefiro café",
        category: "preference",
        capturedAt: Date.now(),
      },
      [0.1, 0.2],
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it("listCaptured returns items", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          points: [
            {
              id: "abc",
              payload: {
                text: "prefiro café",
                category: "preference",
                capturedAt: 123,
                sessionKey: "agent:main",
              },
            },
          ],
          next_page_offset: "next",
        },
      }),
    });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    const res = await client.listCaptured("preference", 10);
    expect(res.items[0].text).toBe("prefiro café");
    expect(res.nextOffset).toBe("next");
  });

  it("deleteCaptured deletes by id", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.deleteCaptured("abc");

    expect(mockFetch).toHaveBeenCalled();
  });

  it("search maps results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: [
          {
            id: "1",
            score: 0.7,
            payload: {
              file: "vault/test.md",
              startLine: 1,
              endLine: 2,
              text: "hello",
            },
          },
        ],
      }),
    });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    const results = await client.search([0.1], 3, 0.1);
    expect(results[0].source).toBe("vault");
  });

  it("searchForDuplicates handles existing and error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: [{ score: 0.99, payload: { text: "dup" } }],
      }),
    });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    const res = await client.searchForDuplicates([0.1], 0.9);
    expect(res.exists).toBe(true);
    expect(res.error).toBeUndefined();

    vi.clearAllMocks();
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const res2 = await client.searchForDuplicates([0.1], 0.9);
    expect(res2.exists).toBe(false);
    expect(res2.error).toContain("network error");
  });

  it("healthCheck succeeds when Qdrant is reachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.healthCheck()).resolves.toBeUndefined();
  });

  it("healthCheck fails when Qdrant is unreachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.healthCheck()).rejects.toThrow();
  });

  it("fetch throws on error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.search([0.1], 1, 0.1)).rejects.toThrow();
  });
});

describe("Qdrant API: wait=true for Critical Operations", () => {
  it("uses wait=true for delete operations to avoid race conditions", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.deleteByFile("test.md");

    const deleteCall = mockFetch.mock.calls.find((call) => call[0].includes("/points/delete"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain("wait=true");
  });

  it("uses wait=true for captured memory deletion", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.deleteCaptured("123");

    const deleteCall = mockFetch.mock.calls.find((call) => call[0].includes("/points/delete"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain("wait=true");
  });

  it("uses wait=true for upsert operations", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.upsert(
      [
        {
          id: "1",
          file: "test.md",
          startLine: 1,
          endLine: 10,
          text: "test content",
          hash: "abc123",
        },
      ],
      [[0.1, 0.2, 0.3]],
    );

    const upsertCall = mockFetch.mock.calls.find((call) => call[0].includes("/points"));
    expect(upsertCall).toBeDefined();
    expect(upsertCall[0]).toContain("wait=true");
  });
});

describe("Qdrant API: capturedAt Index with Principal Flag", () => {
  it("creates principal index for capturedAt field", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.ensurePayloadIndexes();

    const indexCalls = mockFetch.mock.calls.filter((call) => call[0].includes("/index"));
    const capturedAtCall = indexCalls.find((call) => {
      const body = JSON.parse(call[1]?.body as string);
      return body.field_name === "capturedAt";
    });

    expect(capturedAtCall).toBeDefined();
    const body = JSON.parse(capturedAtCall[1]?.body as string);
    expect(body.field_schema.type).toBe("integer");
    expect(body.field_schema.range).toBe(true);
    expect(body.field_schema.lookup).toBe(false);
    expect(body.field_schema.is_principal).toBe(true);
  });

  it("creates keyword indexes for file, category, source", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.ensurePayloadIndexes();

    const indexCalls = mockFetch.mock.calls.filter((call) => call[0].includes("/index"));

    expect(indexCalls.length).toBe(4);

    const keywordFields = ["file", "category", "source"];
    for (const field of keywordFields) {
      const fieldCall = indexCalls.find((call) => {
        const body = JSON.parse(call[1]?.body as string);
        return body.field_name === field;
      });
      expect(fieldCall).toBeDefined();
      const body = JSON.parse(fieldCall[1]?.body as string);
      expect(body.field_schema).toBe("keyword");
    }
  });
});

describe("Qdrant API: Batch Operations for Atomicity", () => {
  it("uses batch API for atomic delete + upsert", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");
    await qdrant.batchUpsertFile(
      "test.md",
      [
        {
          id: "1",
          file: "test.md",
          startLine: 1,
          endLine: 10,
          text: "test content",
          hash: "abc123",
        },
      ],
      [[0.1, 0.2, 0.3]],
    );

    const batchCall = mockFetch.mock.calls.find((call) => call[0].includes("/points/batch"));
    expect(batchCall).toBeDefined();
    expect(batchCall[0]).toContain("wait=true");

    const body = JSON.parse(batchCall[1]?.body as string);
    expect(body.operations).toBeDefined();
    expect(body.operations.length).toBe(2);

    expect(body.operations[0].delete).toBeDefined();
    expect(body.operations[0].delete.filter.must[0].key).toBe("file");
    expect(body.operations[0].delete.filter.must[0].match.value).toBe("test.md");

    expect(body.operations[1].upsert).toBeDefined();
    expect(body.operations[1].upsert.points.length).toBe(1);
    expect(body.operations[1].upsert.points[0].payload.file).toBe("test.md");
  });
});

describe("Qdrant API: Integration Test", () => {
  it("ensures all optimizations work together", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { exists: false } }),
    });

    const qdrant = new QdrantClient("http://localhost:6333", "test-collection");

    await qdrant.ensureCollection(768);

    const createCall = mockFetch.mock.calls.find(
      (call) =>
        call[0].includes("/collections/test-collection") &&
        !call[0].includes("/exists") &&
        call[1]?.method === "PUT",
    );
    expect(createCall).toBeDefined();

    const createBody = JSON.parse(createCall[1]?.body as string);
    expect(createBody.quantization_config.scalar).toBeDefined();
    expect(createBody.quantization_config.scalar.type).toBe("int8");

    const indexCalls = mockFetch.mock.calls.filter((call) => call[0].includes("/index"));
    expect(indexCalls.length).toBe(4);

    const capturedAtIndex = indexCalls.find((call) => {
      const body = JSON.parse(call[1]?.body as string);
      return body.field_name === "capturedAt";
    });
    expect(capturedAtIndex).toBeDefined();
    const capturedAtBody = JSON.parse(capturedAtIndex[1]?.body as string);
    expect(capturedAtBody.field_schema.is_principal).toBe(true);
  });
});
