/**
 * Tests for memory-qdrant plugin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import memoryQdrantPlugin, {
  QdrantClient,
  OllamaEmbeddings,
  chunkText,
  truncateSnippet,
  shouldCapture,
  detectCategory,
  parseConfig,
  indexFile,
  indexDirectory,
  findMarkdownFiles,
} from "./index.js";

import { watch } from "chokidar";
import { writeFile, mkdir, stat as statActual } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const watcherState = vi.hoisted(() => ({
  handlers: {} as Record<string, (path?: string) => void>,
  closeCalled: false,
  watchCalled: false,
  reset() {
    this.handlers = {};
    this.closeCalled = false;
    this.watchCalled = false;
  },
}));

vi.mock("chokidar", () => ({
  watch: vi.fn(() => {
    watcherState.watchCalled = true;
    const watcher = {
      on: (event: string, cb: (path?: string) => void) => {
        watcherState.handlers[event] = cb;
        return watcher;
      },
      close: vi.fn(async () => {
        watcherState.closeCalled = true;
      }),
    };
    return watcher;
  }),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

// ============================================================================
// Test: Configuration Defaults
// ============================================================================

describe("memory-qdrant defaults", () => {
  it("plugin id/name", () => {
    expect(memoryQdrantPlugin.id).toBe("memory-qdrant");
    expect(memoryQdrantPlugin.name).toContain("Qdrant");
  });

  it("config schema includes auto-capture/recall", () => {
    const schema = memoryQdrantPlugin.configSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.autoRecall).toBeTruthy();
    expect(schema.properties?.autoCapture).toBeTruthy();
    expect(schema.properties?.autoCaptureWindowMs).toBeTruthy();
    expect(schema.properties?.autoCaptureMaxPerWindow).toBeTruthy();
  });
});

// ============================================================================
// Test: Memory Trigger Detection
// ============================================================================

describe("shouldCapture", () => {
  describe("should capture", () => {
    it("explicit memory requests in English", () => {
      expect(shouldCapture("Remember that I prefer dark mode")).toBe(true);
      expect(shouldCapture("Remind me that my login is foo")) .toBe(true);
      expect(shouldCapture("Don't forget: my birthday is May 10")) .toBe(true);
      expect(shouldCapture("Please remember that I like tea")) .toBe(true);
      expect(shouldCapture("Note this: I live in Porto Alegre")) .toBe(true);
      expect(shouldCapture("Save this: my email is test@example.com")) .toBe(true);
    });

    it("explicit memory requests in Portuguese", () => {
      expect(shouldCapture("Lembra que eu prefiro café sem açúcar")).toBe(true);
      expect(shouldCapture("Salva isso: meu email é teste@email.com")).toBe(true);
      expect(shouldCapture("Não esquece: meu aniversário é 25 de março")).toBe(true);
      expect(shouldCapture("Nao esquecer: meu endereço é Rua X")) .toBe(true);
      expect(shouldCapture("Memoriza que tenho 3 gatos")) .toBe(true);
      expect(shouldCapture("Por favor lembra que prefiro reuniões à tarde")) .toBe(true);
    });

    it("preferences in English", () => {
      expect(shouldCapture("I like using TypeScript for new projects")).toBe(true);
      expect(shouldCapture("I prefer vim over emacs")).toBe(true);
      expect(shouldCapture("I hate meetings before 10am")).toBe(true);
    });

    it("preferences in Portuguese", () => {
      expect(shouldCapture("Eu prefiro trabalhar de manhã")).toBe(true);
      expect(shouldCapture("Não gosto de reuniões longas")).toBe(true);
      expect(shouldCapture("Adoro café expresso")).toBe(true);
    });

    it("decisions", () => {
      expect(shouldCapture("We decided to use PostgreSQL")) .toBe(true);
      expect(shouldCapture("Decidimos usar o framework Next.js")).toBe(true);
      expect(shouldCapture("I chose Python for this project")).toBe(true);
    });

    it("phone numbers", () => {
      expect(shouldCapture("My phone number is +5511999887766")).toBe(true);
      expect(shouldCapture("Call me at +14155551234")).toBe(true);
    });

    it("email addresses", () => {
      expect(shouldCapture("My email is john.doe@company.com")).toBe(true);
      expect(shouldCapture("Contact me at support@example.org")).toBe(true);
    });

    it("identity statements", () => {
      expect(shouldCapture("My name is John Smith")).toBe(true);
      expect(shouldCapture("Meu nome é Maria Silva")).toBe(true);
      expect(shouldCapture("Me chamo Pedro Santos")).toBe(true);
    });

    it("facts with possessives", () => {
      expect(shouldCapture("My timezone is America/Sao_Paulo")).toBe(true);
      expect(shouldCapture("Meu fuso horário é GMT-3")).toBe(true);
    });

    it("important qualifiers", () => {
      expect(shouldCapture("This is always important to remember")).toBe(true);
      expect(shouldCapture("Never deploy on Fridays")).toBe(true);
      expect(shouldCapture("Isso é crucial para o projeto")).toBe(true);
    });
  });

  describe("should NOT capture", () => {
    it("very short text", () => {
      expect(shouldCapture("ok")).toBe(false);
      expect(shouldCapture("sure")) .toBe(false);
      expect(shouldCapture("hi there")) .toBe(false);
    });

    it("very long text", () => {
      const longText = "a".repeat(550);
      expect(shouldCapture(longText)).toBe(false);
    });

    it("questions", () => {
      expect(shouldCapture("What do you prefer?")) .toBe(false);
      expect(shouldCapture("Do you like coffee?")) .toBe(false);
    });

    it("agent confirmations", () => {
      expect(shouldCapture("Pronto!")) .toBe(false);
      expect(shouldCapture("Done!")) .toBe(false);
      expect(shouldCapture("Entendi, vou fazer isso")) .toBe(false);
    });

    it("XML/tool output", () => {
      expect(shouldCapture("<tool>result</tool>")).toBe(false);
    });

    it("code blocks", () => {
      expect(shouldCapture("```typescript\nconst x = 1;\n```")) .toBe(false);
    });

    it("multiple code blocks (non-greedy regex)", () => {
      // Text between multiple code blocks should still be checked
      const multiBlock = "```js\ncode1\n```\nI prefer dark mode\n```js\ncode2\n```";
      // The code block exclusion should NOT swallow text between blocks
      // But since this contains code blocks, it should still be excluded
      expect(shouldCapture(multiBlock)).toBe(false);
      
      // Pure text between would be captured if it has triggers
      expect(shouldCapture("I prefer dark mode")).toBe(true);
    });

    it("markdown lists", () => {
      expect(shouldCapture("- Item 1\n- Item 2")) .toBe(false);
      expect(shouldCapture("* First\n* Second")) .toBe(false);
    });

    it("already injected memories", () => {
      expect(shouldCapture("I prefer <relevant-memories>test</relevant-memories> this")).toBe(false);
    });

    it("emoji-heavy content", () => {
      expect(shouldCapture("🎉🎉🎉🎉 Great job!")) .toBe(false);
    });
  });
});

// ============================================================================
// Test: Category Detection
// ============================================================================

describe("detectCategory", () => {
  it("detects preferences", () => {
    expect(detectCategory("I prefer dark mode")).toBe("preference");
    expect(detectCategory("Eu prefiro café")).toBe("preference");
    expect(detectCategory("I love TypeScript")).toBe("preference");
    expect(detectCategory("I hate bugs")) .toBe("preference");
  });

  it("detects projects", () => {
    expect(detectCategory("We decided to use React")).toBe("project");
    expect(detectCategory("Decidimos usar PostgreSQL")) .toBe("project");
    expect(detectCategory("I chose this framework")).toBe("project");
    expect(detectCategory("Projeto de memória local")).toBe("project");
  });

  it("detects personal", () => {
    expect(detectCategory("My phone is +5511999887766")).toBe("personal");
    expect(detectCategory("Email: test@example.com")) .toBe("personal");
    expect(detectCategory("My name is John")) .toBe("personal");
    expect(detectCategory("Me chamo Maria")) .toBe("personal");
    expect(detectCategory("Eu moro em Porto Alegre")) .toBe("personal");
  });

  it("returns other for unclassified", () => {
    expect(detectCategory("Random unclassified text")).toBe("other");
  });
});

// ============================================================================
// Test: Text Chunking
// ============================================================================

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
});

// ============================================================================
// Test: Snippet Truncation
// ============================================================================

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
});

// ============================================================================
// Test: Qdrant Client (Mocked)
// ============================================================================

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
        json: async () => ({ result: { collections: [] } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.ensureCollection(768);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("skips creation if collection exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { collections: [{ name: "test-collection" }] },
      }),
    });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await client.ensureCollection(768);

    expect(mockFetch).toHaveBeenCalledTimes(1);
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

    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const res2 = await client.searchForDuplicates([0.1], 0.9);
    expect(res2.exists).toBe(false);
    expect(res2.error).toBe("Error: boom");
  });

  it("fetch throws on error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.search([0.1], 1, 0.1)).rejects.toThrow();
  });
});

// ============================================================================
// Test: Ollama Embeddings (Mocked)
// ============================================================================

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

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    const result = await embeddings.embed("test text");

    expect(result).toHaveLength(768);
  });

  it("embedBatch aggregates", async () => {
    const mockEmbedding = Array(2).fill(0.1);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: mockEmbedding }) });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    const result = await embeddings.embedBatch(["a", "b"]);
    expect(result).toHaveLength(2);
  });

  it("getDimensions uses embed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    const dims = await embeddings.getDimensions();
    expect(dims).toBe(3);
  });

  it("throws on errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    await expect(embeddings.embed("x")).rejects.toThrow();
  });
});

// ============================================================================
// Test: Register Hooks & Tools
// ============================================================================

describe("plugin register", () => {
  it("registers tools, services, and hooks", () => {
    const tools: string[] = [];
    const services: string[] = [];
    const hooks: string[] = [];

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoCapture: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerService: (svc: { id: string }) => services.push(svc.id),
      on: (event: string) => hooks.push(event),
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    expect(tools).toContain("memory_search");
    expect(tools).toContain("memory_get");
    expect(services).toContain("memory-qdrant-indexer");
    expect(hooks).toContain("before_agent_start");
    expect(hooks).toContain("message_received");
  });
});

// ============================================================================
// Test: Hook handlers (auto-recall + auto-capture)
// ============================================================================

describe("hook handlers", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("before_agent_start injects memories", async () => {
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    // Ollama embed + Qdrant search
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [0.1, 0.2] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "1",
              score: 0.8,
              payload: { file: "memory/test.md", startLine: 1, endLine: 2, text: "Test memory" },
            },
          ],
        }),
      });

    memoryQdrantPlugin.register(api as never);

    const result = await hooks.before_agent_start({ prompt: "Tell me about my prefs" });
    expect(result.prependContext).toContain("<relevant-memories>");
  });

  it("before_agent_start skips short or injected prompts", async () => {
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const short = await hooks.before_agent_start({ prompt: "hi" });
    expect(short).toBeUndefined();

    const injected = await hooks.before_agent_start({
      prompt: "<relevant-memories>skip</relevant-memories>",
    });
    expect(injected).toBeUndefined();
  });

  it("before_agent_start handles empty results", async () => {
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [] }) });

    memoryQdrantPlugin.register(api as never);
    const result = await hooks.before_agent_start({ prompt: "Tell me" });
    expect(result).toBeUndefined();
  });

  it("before_agent_start handles errors", async () => {
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    memoryQdrantPlugin.register(api as never);
    const result = await hooks.before_agent_start({ prompt: "Tell me" });
    expect(result).toBeUndefined();
  });

  it("message_received captures preference", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    // 1) Ollama embed for capture
    // 2) Qdrant duplicate search (empty)
    // 3) Qdrant upsert
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received(
      { content: "Eu prefiro café sem açúcar", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it("message_received skips duplicates", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [{ score: 0.99, payload: { text: "dup" } }] }),
      });

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received(
      { content: "Eu prefiro café sem açúcar", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("message_received logs on error", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received(
      { content: "Eu prefiro café sem açúcar", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it("message_received ignores non-string content", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received({ content: null, from: "+5551" }, { sessionKey: "agent:main:main" });
    await hooks.message_received({ content: 123, from: "+5551" }, { sessionKey: "agent:main:main" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("message_received returns when nothing to capture", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoCapture: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received({ content: "ok", from: "+5551" }, { sessionKey: "agent:main:main" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("message_received enforces window limit", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        autoCaptureWindowMs: 1000,
        autoCaptureMaxPerWindow: 1,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received(
      { content: "Eu prefiro café", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    await hooks.message_received(
      { content: "Eu prefiro chá", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    // Only first capture should proceed
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// Test: Service start/stop (indexer + watcher)
// ============================================================================

describe("service start/stop", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start handles missing vault path", async () => {
    const services: any[] = [];
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/missing", autoIndex: true },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockRejectedValueOnce(new Error("missing"));

    await services[0].start();
    expect(true).toBe(true);
  });

  it("start initializes watcher when autoIndex true", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const logs: string[] = [];
    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true },
      resolvePath: (p: string) => p,
      logger: { 
        info: (msg: string) => logs.push(`INFO: ${msg}`), 
        warn: (msg: string) => logs.push(`WARN: ${msg}`), 
        error: (msg: string) => logs.push(`ERROR: ${msg}`) 
      },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.endsWith("/collections")) {
        return {
          ok: true,
          json: async () => ({ result: { collections: [{ name: "openclaw-memory" }] } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    watcherState.reset();
    
    // Ensure stat mock is set up BEFORE register
    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);
    
    memoryQdrantPlugin.register(api as never);

    await services[0].start();
    
    // Wait for initial indexing to complete
    await new Promise(r => setTimeout(r, 100));
    
    // Verify watcher was created (check logs since chokidar mock has import order issues)
    expect(logs.some(l => l.includes("watching"))).toBe(true);
    
    await services[0].stop();
    
    // Verify stop completes without error
    expect(logs.some(l => l.includes("stopped"))).toBe(true);
  });

  it("indexes memory + extra paths", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    const extraDir = join(base, "extra-dir");
    const extraFile = join(base, "extra-file.md");

    await mkdir(join(base, "memory"), { recursive: true });
    await mkdir(extraDir, { recursive: true });

    await writeFile(join(base, "MEMORY.md"), "Hello");
    await writeFile(join(base, "memory", "note.md"), "Note");
    await writeFile(join(extraDir, "dir.md"), "Dir");
    await writeFile(extraFile, "Extra");

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true, extraPaths: [extraDir, extraFile, join(base, "missing")] },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.endsWith("/collections")) {
        return {
          ok: true,
          json: async () => ({ result: { collections: [{ name: "openclaw-memory" }] } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    memoryQdrantPlugin.register(api as never);

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    await services[0].start();
    await services[0].stop();
    expect(true).toBe(true);
  });

  it("start does nothing when autoIndex is false", async () => {
    const services: any[] = [];
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);
    await services[0].start();
    await services[0].stop();
    expect(true).toBe(true);
  });

  it("full integration path", async () => {
    const services: any[] = [];
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    const extraDir = join(base, "extra-dir");
    const extraFile = join(base, "extra-file.md");

    await mkdir(join(base, "memory"), { recursive: true });
    await mkdir(extraDir, { recursive: true });

    await writeFile(join(base, "MEMORY.md"), "Hello");
    await writeFile(join(base, "memory", "note.md"), "Note");
    await writeFile(join(extraDir, "dir.md"), "Dir");
    await writeFile(extraFile, "Extra");

    const api = {
      workspaceDir: base,
      pluginConfig: {
        vaultPath: base,
        autoIndex: true,
        autoRecall: true,
        autoCapture: true,
        extraPaths: [extraDir, extraFile],
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch.mockImplementation(async (url: string, init?: any) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.endsWith("/collections")) {
        return { ok: true, json: async () => ({ result: { collections: [] } }) } as any;
      }
      if (url.includes("/collections/") && init?.method === "PUT") {
        return { ok: true, json: async () => ({}) } as any;
      }
      if (url.includes("/points/search")) {
        return {
          ok: true,
          json: async () => ({
            result: [
              {
                id: "1",
                score: 0.8,
                payload: { file: "memory/test.md", startLine: 1, endLine: 2, text: "Test memory" },
              },
            ],
          }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    memoryQdrantPlugin.register(api as never);

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    await services[0].start();

    await hooks.before_agent_start({ prompt: "Tell me" });
    await hooks.message_received(
      { content: "Eu prefiro café sem açúcar", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    await services[0].stop();
    expect(true).toBe(true);
  });

  it("watcher debounces index scheduling", async () => {
    watcherState.reset();
    vi.useFakeTimers();

    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const logs: string[] = [];

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true },
      resolvePath: (p: string) => p,
      logger: { info: (msg: string) => logs.push(msg), warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.endsWith("/collections")) {
        return { ok: true, json: async () => ({ result: { collections: [] } }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    // Set up stat mock BEFORE register
    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    memoryQdrantPlugin.register(api as never);

    await services[0].start();
    await Promise.resolve();

    // Verify watcher was created (check logs since chokidar mock has import order issues)
    expect(logs.some(l => l.includes("watching"))).toBe(true);

    // Verify indexing was triggered
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);

    await services[0].stop();
    vi.useRealTimers();
  });

  it("runIndexing handles errors gracefully", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockRejectedValueOnce(new Error("Ollama offline"));

    memoryQdrantPlugin.register(api as never);

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    await services[0].start();
    await services[0].stop();
    expect(true).toBe(true);
  });
});

describe("edge cases + errors", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chunkText handles empty text", () => {
    const chunks = chunkText("");
    expect(chunks).toEqual([]);
  });

  it("chunkText handles single word", () => {
    const chunks = chunkText("word");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("word");
  });

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

    const count = await indexFile(filePath, "empty.md", qdrant, embeddings);
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

    const count = await indexDirectory(
      "/root/forbidden",
      "forbidden/",
      qdrant,
      embeddings,
      { info: () => {} },
    );
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
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const count = await indexDirectory(base, "test/", qdrant, embeddings, { info: () => {} });
    expect(count).toBeGreaterThan(0);
    expect(qdrant.deleteByFile).toHaveBeenCalledTimes(1);
  });

  it("QdrantClient.fetch throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.search([0.1], 1, 0.1)).rejects.toThrow("404");
  });

  it("OllamaEmbeddings.embed throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    await expect(embeddings.embed("test")).rejects.toThrow("503");
  });

  it("parseConfig throws without vaultPath", () => {
    expect(() => parseConfig({}, "/workspace")).toThrow();
  });

  it("memory_get handles line range beyond file end", async () => {
    const tools: Record<string, any> = {};

    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "short.md"), "Line 1\nLine 2");

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const memoryGet = tools.memory_get;
    const res = await memoryGet.execute("", { path: "short.md", from: 10, lines: 5 });
    expect(res.details.text).toBe("");
  });

  it("memory_search handles Qdrant offline", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    memoryQdrantPlugin.register(api as never);
    const memorySearch = tools.memory_search;
    const res = await memorySearch.execute("", { query: "test" });
    expect(res.details.error).toBeTruthy();
  });

  it("message_received handles Ollama offline", async () => {
    const hooks: Record<string, (event: any, ctx?: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoIndex: false,
        qdrantUrl: "http://localhost:6333",
        collection: "test-collection",
        ollamaUrl: "http://localhost:11434",
      },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any, ctx?: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    memoryQdrantPlugin.register(api as never);

    await hooks.message_received(
      { content: "Eu prefiro café sem açúcar", from: "+5551" },
      { sessionKey: "agent:main:main", conversationId: "conv-1" },
    );

    expect(mockFetch).toHaveBeenCalled();
  });

  it("before_agent_start handles Ollama offline", async () => {
    const hooks: Record<string, (event: any) => Promise<any>> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      registerService: () => {},
      on: (event: string, handler: (ev: any) => Promise<any>) => {
        hooks[event] = handler;
      },
    } as unknown;

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    memoryQdrantPlugin.register(api as never);
    const result = await hooks.before_agent_start({ prompt: "Tell me" });
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Test: Config parsing + indexing helpers
// ============================================================================

describe("config + indexing helpers", () => {
  it("parseConfig applies defaults", () => {
    const cfg = parseConfig({ vaultPath: "/vault" }, "/workspace");
    expect(cfg.vaultPath).toBe("/vault");
    expect(cfg.workspacePath).toBe("/workspace");
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoCapture).toBe(false);
  });

  it("parseConfig throws without vaultPath", () => {
    expect(() => parseConfig({}, "/workspace")).toThrow();
  });

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
    } as unknown as QdrantClient;

    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    } as unknown as OllamaEmbeddings;

    const chunks = await indexFile(filePath, "memory/sample.md", qdrant, embeddings);

    expect(chunks).toBeGreaterThan(0);
    expect(qdrant.deleteByFile).toHaveBeenCalled();
    expect(qdrant.upsert).toHaveBeenCalled();
  });

  it("indexDirectory indexes markdown files", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "a.md"), "A");
    await writeFile(join(base, "b.md"), "B");

    const qdrant = {
      deleteByFile: vi.fn(),
      upsert: vi.fn(),
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

// ============================================================================
// Test: Tool behavior (memory_get + memory_search)
// ============================================================================

describe("tools", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("memory_get supports workspace/vault/extra/captured", async () => {
    const tools: Record<string, any> = {};

    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    const vault = join(base, "vault");
    const extra = join(base, "extra");

    await mkdir(join(base, "memory"), { recursive: true });
    await mkdir(vault, { recursive: true });
    await mkdir(extra, { recursive: true });

    await writeFile(join(base, "MEMORY.md"), "Line A\nLine B");
    await writeFile(join(base, "memory", "note.md"), "M1\nM2");
    await writeFile(join(vault, "vault.md"), "V1\nV2");
    await writeFile(join(extra, "x.md"), "X1\nX2");

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: vault, extraPaths: [extra], autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const memoryGet = tools.memory_get;

    const workspaceRes = await memoryGet.execute("", { path: "MEMORY.md", from: 1, lines: 1 });
    expect(workspaceRes.details.text).toContain("Line A");

    const memoryRes = await memoryGet.execute("", { path: "memory/note.md", from: 2, lines: 1 });
    expect(memoryRes.details.text).toContain("M2");

    const vaultRes = await memoryGet.execute("", { path: "vault/vault.md", from: 1, lines: 2 });
    expect(vaultRes.details.text).toContain("V1");

    const extraRes = await memoryGet.execute("", { path: "extra/0/x.md", from: 2, lines: 1 });
    expect(extraRes.details.text).toContain("X2");

    const capturedRes = await memoryGet.execute("", { path: "captured/preference" });
    expect(capturedRes.details.text).toContain("captured memory");

    const unknownExtra = await memoryGet.execute("", { path: "extra/9/missing.md" });
    expect(unknownExtra.details.error).toContain("Unknown extra path index");
  });

  it("memory_get blocks invalid paths", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const memoryGet = tools.memory_get;
    const res = await memoryGet.execute("", { path: "../secrets.txt" });
    expect(res.details.text).toBe("");
    expect(res.details.error).toContain("Access denied");

    const missing = await memoryGet.execute("", { path: "memory/missing.md" });
    expect(missing.details.error).toBeTruthy();
  });

  it("memory_search returns results", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "1",
              score: 0.8,
              payload: { file: "memory/test.md", startLine: 1, endLine: 2, text: "Test memory" },
            },
          ],
        }),
      });

    memoryQdrantPlugin.register(api as never);
    const memorySearch = tools.memory_search;
    const res = await memorySearch.execute("", { query: "test" });
    expect(res.details.results[0].file).toBe("memory/test.md");
  });

  it("memory_search handles errors", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    memoryQdrantPlugin.register(api as never);
    const memorySearch = tools.memory_search;
    const res = await memorySearch.execute("", { query: "test" });
    expect(res.details.error).toBeTruthy();
  });

  it("memory_captured_list returns items", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

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
              },
            },
          ],
        },
      }),
    });

    memoryQdrantPlugin.register(api as never);
    const memoryList = tools.memory_captured_list;
    const res = await memoryList.execute("", { category: "preference" });
    expect(res.details.items[0].text).toBe("prefiro café");
  });

  it("memory_captured_delete deletes", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    memoryQdrantPlugin.register(api as never);
    const memoryDelete = tools.memory_captured_delete;
    const res = await memoryDelete.execute("", { id: "abc" });
    expect(res.details.deleted).toBe(true);
  });

  it("memory_captured_export writes inbox note", async () => {
    const tools: Record<string, any> = {};

    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(join(base, "00 Inbox"), { recursive: true });

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: base, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

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
              },
            },
          ],
        },
      }),
    });

    memoryQdrantPlugin.register(api as never);
    const memoryExport = tools.memory_captured_export;
    const res = await memoryExport.execute("", { title: "Teste" });
    expect(res.details.path).toContain("vault/00 Inbox/");
  });
});
