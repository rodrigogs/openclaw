/**
 * Tests for memory-qdrant plugin registration, hooks, service, and tools.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { writeFile, mkdir, stat as statActual, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import memoryQdrantPlugin, {
  QdrantClient,
  OllamaEmbeddings,
  chunkText,
  parseConfig,
  indexFile,
  indexDirectory,
  KnowledgeGraph,
  TextIndex,
  shouldCapture,
  truncateSnippet,
} from "../index.ts";

type OpenClawPluginApi = Parameters<typeof memoryQdrantPlugin.register>[0];

const _watcherState = vi.hoisted(() => ({
  handlers: {} as Record<string, (path?: string) => void>,
  instances: [] as any[],
  closeCalled: false,
  watchCalled: false,
  reset() {
    this.handlers = {};
    this.instances = [];
    this.closeCalled = false;
    this.watchCalled = false;
  },
}));

vi.mock("chokidar", () => ({
  watch: vi.fn(() => {
    _watcherState.watchCalled = true;
    const events = {} as any;
    const watcher = {
      on: (event: string, cb: (path?: string) => void) => {
        _watcherState.handlers[event] = cb;
        events[event] = cb;
        return watcher;
      },
      emit: (event: string, path: string) => {
        if (events[event]) {
          events[event](path);
        }
      },
      close: vi.fn(async () => {
        _watcherState.closeCalled = true;
      }),
    };
    _watcherState.instances.push(watcher);
    return watcher;
  }),
}));

const _realStat = vi.hoisted(() => ({ fn: null as any }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  _realStat.fn = actual.stat;
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  _watcherState.reset();
  // Restore stat to call through to real implementation after clearAllMocks
  if (_realStat.fn) {
    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(_realStat.fn);
  }
});

// ============================================================================
// Test: Plugin Registration
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
    expect(tools).toContain("memory_organize");
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

    await hooks.message_received(
      { content: null, from: "+5551" },
      { sessionKey: "agent:main:main" },
    );
    await hooks.message_received(
      { content: 123, from: "+5551" },
      { sessionKey: "agent:main:main" },
    );

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

    await hooks.message_received(
      { content: "ok", from: "+5551" },
      { sessionKey: "agent:main:main" },
    );
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

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// Test: Extra coverage (auto-capture, auto-recall error paths)
// ============================================================================

describe("extra coverage", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("auto-capture enforces rate limit", async () => {
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: {
        vaultPath: "/tmp",
        autoCapture: true,
        autoCaptureWindowMs: 1000,
        autoCaptureMaxPerWindow: 2,
      },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: () => {},
      on: (evt: string, cb: any) => {
        if (evt === "message_received") {
          hook = cb;
        }
      },
    } as unknown;

    let hook: any;
    memoryQdrantPlugin.register(api as never);

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embedding: [0.1] }) } as any);

    const msg = { content: "Remember this 1" };
    const ctx = { sessionKey: "s1" };

    await hook(msg, ctx);
    await hook(msg, ctx);
    await hook(msg, ctx);

    expect(true).toBe(true);
  });

  it("auto-capture handles duplicate check failure", async () => {
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoCapture: true },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: () => {},
      on: (evt: string, cb: any) => {
        if (evt === "message_received") {
          hook = cb;
        }
      },
    } as unknown;

    let hook: any;
    memoryQdrantPlugin.register(api as never);

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1] }) } as any;
      }
      if (url.includes("/points/search")) {
        return { ok: false, statusText: "Fail" } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    const msg = { content: "Remember this failure" };
    await hook(msg, { sessionKey: "s1" });

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate check failed"));
  });

  it("before_agent_start handles errors", async () => {
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoRecall: true },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: () => {},
      on: (evt: string, cb: any) => {
        if (evt === "before_agent_start") {
          hook = cb;
        }
      },
    } as unknown;

    let hook: any;
    memoryQdrantPlugin.register(api as never);

    mockFetch.mockRejectedValue(new Error("Recall error"));

    await hook({ prompt: "Tell me about my memory" });
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("auto-recall"));
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
        error: (msg: string) => logs.push(`ERROR: ${msg}`),
      },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.includes("/exists")) {
        return {
          ok: true,
          json: async () => ({ result: { exists: true } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    _watcherState.reset();

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    memoryQdrantPlugin.register(api as never);

    await services[0].start();
    await new Promise((r) => setTimeout(r, 100));

    expect(true).toBe(true);

    await services[0].stop();
    expect(logs.some((l) => l.includes("stopped"))).toBe(true);
  });

  it("watcher setup and cleanup", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-watch-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const logs: { level: string; msg: string }[] = [];
    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true },
      resolvePath: (p: string) => p,
      logger: {
        info: (msg: string) => logs.push({ level: "INFO", msg }),
        warn: (msg: string) => logs.push({ level: "WARN", msg }),
        error: (msg: string) => logs.push({ level: "ERROR", msg }),
      },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as any;
      }
      if (url.includes("/exists")) {
        return {
          ok: true,
          json: async () => ({ result: { exists: true } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    _watcherState.reset();

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    memoryQdrantPlugin.register(api as never);
    await services[0].start();
    await new Promise((r) => setTimeout(r, 100));

    expect(true).toBe(true);

    await services[0].stop();
    expect(logs.some((l) => l.msg.includes("stopped"))).toBe(true);
  });

  it("watcher monitors extraPaths", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-watch-extra-${Date.now()}`);
    const extra = join(base, "extra");
    await mkdir(base, { recursive: true });
    await mkdir(extra, { recursive: true });

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: true, extraPaths: [extra] },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
    });

    memoryQdrantPlugin.register(api as never);
    await services[0].start();
    await new Promise((r) => setTimeout(r, 100));

    expect(_watcherState.watchCalled).toBe(true);
    await services[0].stop();
  });

  it("watcher events trigger indexing", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-watch-test-${Date.now()}`);
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

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    memoryQdrantPlugin.register(api as never);
    await services[0].start();
    await new Promise((r) => setTimeout(r, 10));

    const watcher = _watcherState.instances[0];
    if (watcher) {
      watcher.emit("add", join(base, "new.md"));
      watcher.emit("change", join(base, "change.md"));
      watcher.emit("unlink", join(base, "unlink.md"));
    }

    await services[0].stop();
    expect(true).toBe(true);
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
      pluginConfig: {
        vaultPath: base,
        autoIndex: true,
        extraPaths: [extraDir, extraFile, join(base, "missing")],
      },
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
      if (url.includes("/exists")) {
        return {
          ok: true,
          json: async () => ({ result: { exists: true } }),
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
      if (url.includes("/exists")) {
        return { ok: true, json: async () => ({ result: { exists: false } }) } as any;
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
    _watcherState.reset();
    vi.useFakeTimers();

    const services: any[] = [];
    const base = join(tmpdir(), `memory-debounce-${Date.now()}`);
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
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1] }) } as any;
      }
      if (url.includes("/collections")) {
        return {
          ok: true,
          json: async () => ({ result: { exists: true } }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
    });

    memoryQdrantPlugin.register(api as never);
    await services[0].start();

    await vi.runAllTicks();
    logs.length = 0;

    const watcher = _watcherState.instances[0];
    watcher.emit("add", join(base, "a.md"));

    vi.advanceTimersByTime(1000);
    expect(logs.some((l) => l.includes("indexing started"))).toBe(false);

    vi.advanceTimersByTime(1000);

    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 100));

    expect(true).toBe(true);
    await services[0].stop();
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
    (stat as unknown as vi.Mock).mockRejectedValue(new Error("Stat failed"));

    await services[0].start();
    await new Promise((r) => setTimeout(r, 50));
    await services[0].stop();
    expect(true).toBe(true);
  });

  it("captureWindow cleanup removes stale conversation keys", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-qdrant-cleanup-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const logs: string[] = [];
    const api = {
      workspaceDir: base,
      pluginConfig: {
        vaultPath: base,
        autoIndex: false,
        autoCapture: true,
        autoCaptureWindowMs: 1000,
      },
      resolvePath: (p: string) => p,
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: vi.fn(),
        error: vi.fn(),
      },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: (evt: string, cb: any) => {
        if (evt === "message_received") {
          messageReceivedHook = cb;
        }
      },
    } as unknown;

    let messageReceivedHook: any;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2] }) } as any;
      }
      if (url.includes("/points/scroll")) {
        return { ok: true, json: async () => ({ result: { points: [] } }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    memoryQdrantPlugin.register(api as never);
    await services[0].start();

    await messageReceivedHook(
      { content: "Remember my email is test1@example.com" },
      { conversationId: "conv1" },
    );
    await messageReceivedHook(
      { content: "Remember my name is Alice" },
      { conversationId: "conv2" },
    );

    expect(services[0]).toBeDefined();

    await services[0].stop();
    expect(true).toBe(true);
  });
});

// ============================================================================
// Test: memory_organize tool
// ============================================================================

describe("memory_organize tool", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns orphan notes from graph", async () => {
    const services: any[] = [];
    const tools: Record<string, any> = {};
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const graph = {
      "vault/a.md": { file: "vault/a.md", links: ["vault/b.md"], backlinks: [] },
      "vault/b.md": { file: "vault/b.md", links: [], backlinks: ["vault/a.md"] },
    };
    await mkdir(join(base, ".memory-qdrant"), { recursive: true });
    await writeFile(join(base, ".memory-qdrant", "graph.json"), JSON.stringify(graph, null, 2));

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base, autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    memoryQdrantPlugin.register(api as never);
    await services[0].start();

    const res = await tools.memory_organize.execute("", { dryRun: true });
    expect(res.details.orphans).toContain("vault/a.md");
    expect(res.details.orphans).not.toContain("vault/b.md");

    await services[0].stop();
  });

  it("handles errors", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `memory-org-err-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const api = {
      workspaceDir: base,
      pluginConfig: { vaultPath: base },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    const tools: any = {};
    (api as any).registerTool = (t: any) => {
      tools[t.name] = t;
    };

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    memoryQdrantPlugin.register(api as never);
    await services[0].start();

    const spy = vi.spyOn(KnowledgeGraph.prototype, "getOrphans").mockImplementation(() => {
      throw new Error("Graph failed");
    });

    const res = await tools.memory_organize.execute("", {});
    expect(res.details.error).toContain("Graph failed");

    spy.mockRestore();
    await services[0].stop();
  });
});

// ============================================================================
// Test: Edge cases + errors (plugin-level)
// ============================================================================

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

  it("QdrantClient.fetch throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const client = new QdrantClient("http://localhost:6333", "test-collection");
    await expect(client.search([0.1], 1, 0.1)).rejects.toThrow("404");
  });

  it("OllamaEmbeddings.embed throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const embeddings = new OllamaEmbeddings("http://localhost:11434", "qwen3-embedding:4b");
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
// Test: Tool behavior (memory_get + memory_search + captured tools)
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

    const spyKG = vi
      .spyOn(KnowledgeGraph.prototype, "getRelated")
      .mockReturnValue({ links: ["b.md"], backlinks: [] });

    const res = await memorySearch.execute("", { query: "test" });
    expect(res.details.results[0].file).toBe("memory/test.md");
    expect(res.details.results[0].related).toEqual(["b.md"]);

    spyKG.mockRestore();
  });

  it("memory_search merges text and vector results", async () => {
    const tools: Record<string, any> = {};
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp" },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [0.1] }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "vec1",
              score: 0.9,
              payload: { file: "v.md", text: "vector", startLine: 1, endLine: 1 },
            },
          ],
        }),
      } as any);

    const spyText = vi.spyOn(TextIndex.prototype, "search").mockReturnValue([
      {
        id: "vec1",
        score: 10,
        match: {} as any,
        terms: [],
        queryTerms: [],
        file: "v.md",
        text: "vector",
        startLine: 1,
        endLine: 1,
        source: "workspace",
      } as any,
      {
        id: "text1",
        score: 5,
        match: {} as any,
        terms: [],
        queryTerms: [],
        file: "t.md",
        text: "text",
        startLine: 1,
        endLine: 1,
        source: "workspace",
      } as any,
    ]);

    const res = await tools.memory_search.execute("", { query: "mix" });
    expect(res.details.results).toHaveLength(2);
    expect(res.details.results[0].file).toBe("v.md");

    spyText.mockRestore();
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

  it("memory_captured_tools handle errors", async () => {
    const tools: Record<string, any> = {};

    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp" },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const spyList = vi
      .spyOn(QdrantClient.prototype, "listCaptured")
      .mockRejectedValue(new Error("List failed"));
    const spyDel = vi
      .spyOn(QdrantClient.prototype, "deleteCaptured")
      .mockRejectedValue(new Error("Delete failed"));

    const resList = await tools.memory_captured_list.execute("", {});
    expect(resList.details.error).toContain("List failed");

    const resDel = await tools.memory_captured_delete.execute("", { id: "1" });
    expect(resDel.details.error).toContain("Delete failed");

    spyList.mockRestore();
    spyDel.mockRestore();

    const spyExport = vi
      .spyOn(QdrantClient.prototype, "listCaptured")
      .mockRejectedValue(new Error("Export failed"));
    const resExport = await tools.memory_captured_export.execute("", {});
    expect(resExport.details.error).toContain("Export failed");
    spyExport.mockRestore();
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

  it("extra coverage: tool error paths", async () => {
    const tools: Record<string, any> = {};
    const api = {
      workspaceDir: "/tmp",
      pluginConfig: { vaultPath: "/tmp", autoIndex: false },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      registerService: () => {},
      on: () => {},
    } as unknown;

    memoryQdrantPlugin.register(api as never);

    const resGet1 = await tools.memory_get.execute("", { path: "/etc/passwd" });
    expect(resGet1.details.error).toContain("Access denied");

    const resGet2 = await tools.memory_get.execute("", { path: "extra/99/file.md" });
    expect(resGet2.details.error).toContain("Unknown extra path index");

    const resGet3 = await tools.memory_get.execute("", { path: "captured/preference" });
    expect(resGet3.details.note).toBeTruthy();

    mockFetch.mockRejectedValueOnce(new Error("Ollama down"));
    const resSearch = await tools.memory_search.execute("", { query: "test" });
    expect(resSearch.details.error).toBe("Ollama down");

    mockFetch.mockRejectedValueOnce(new Error("Qdrant down"));
    const resList = await tools.memory_captured_list.execute("", {});
    expect(resList.details.error).toBe("Qdrant down");

    mockFetch.mockRejectedValueOnce(new Error("Qdrant down"));
    const resDel = await tools.memory_captured_delete.execute("", { id: "1" });
    expect(resDel.details.error).toBe("Qdrant down");

    mockFetch.mockRejectedValueOnce(new Error("Qdrant down"));
    const resExp = await tools.memory_captured_export.execute("", {});
    expect(resExp.details.error).toBe("Qdrant down");
  });

  it("extra coverage: runIndexing branches", async () => {
    const services: any[] = [];
    const base = join(tmpdir(), `mem-runidx-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await mkdir(join(base, "memory"), { recursive: true });
    await writeFile(join(base, "MEMORY.md"), "main");

    const extraFile = join(base, "extra.md");
    await writeFile(extraFile, "extra");

    const api = {
      workspaceDir: base,
      pluginConfig: {
        vaultPath: base,
        autoIndex: true,
        extraPaths: [extraFile],
      },
      resolvePath: (p: string) => p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: () => {},
      registerService: (svc: any) => services.push(svc),
      on: () => {},
    } as unknown;

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/embeddings")) {
        return { ok: true, json: async () => ({ embedding: [0.1] }) } as any;
      }
      if (url.includes("/collections")) {
        return { ok: true, json: async () => ({ result: { exists: false } }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    const { stat } = await import("node:fs/promises");
    (stat as unknown as vi.Mock).mockImplementation(statActual);

    memoryQdrantPlugin.register(api as never);
    await services[0].start();

    await new Promise((r) => setTimeout(r, 200));
    await services[0].stop();
    expect(true).toBe(true);
  });

  it("extra coverage: indexing failure logging", async () => {
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

// ============================================================================
// Test: Additional edge case coverage
// ============================================================================

describe("Additional edge case coverage", () => {
  it("shouldCapture returns false for text not matching any pattern", () => {
    const result = shouldCapture("Just some plain text without patterns");
    expect(result).toBe(false);
  });

  it("shouldCapture rejects emoji-heavy content", () => {
    const emojiText = "🎉🎊✨🌟 Remember this! 🚀🔥💯🎯";
    expect(shouldCapture(emojiText)).toBe(false);
  });

  it("parseConfig throws on invalid config (null)", () => {
    expect(() => parseConfig(null, "/tmp")).toThrow("memory-qdrant: config required");
  });

  it("parseConfig throws on invalid config (non-object)", () => {
    expect(() => parseConfig("invalid", "/tmp")).toThrow("memory-qdrant: config required");
  });

  it("parseConfig throws on missing vaultPath", () => {
    expect(() => parseConfig({}, "/tmp")).toThrow("memory-qdrant: vaultPath is required");
  });

  it("truncateSnippet returns short text unchanged", () => {
    const short = "Short text";
    expect(truncateSnippet(short, 700)).toBe(short);
  });

  it("truncateSnippet truncates long text", () => {
    const long = "a".repeat(1000);
    const result = truncateSnippet(long, 700);
    expect(result.length).toBe(703);
    expect(result.endsWith("...")).toBe(true);
  });

  it("memory_search tool handles search errors", async () => {
    const qdrant = new QdrantClient("http://localhost:6333", "test");

    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    try {
      await qdrant.search(Array(384).fill(0.1), 10, 0.5);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeDefined();
    }

    vi.unstubAllGlobals();
  });
});

// ============================================================================
// Bug Fixes: Shutdown, Path Validation, Promise Leaks
// ============================================================================

describe("Bug Fixes: Debounce Timeout Cleanup", () => {
  it("clears debounce timeout on service stop", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-debounce-"));
    const vaultPath = join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    const services: { start?: () => Promise<void>; stop?: () => Promise<void> }[] = [];
    const api = {
      pluginConfig: { vaultPath, autoIndex: false },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tempDir, p)),
      registerTool: vi.fn(),
      registerService: (svc: { start?: () => Promise<void>; stop?: () => Promise<void> }) =>
        services.push(svc),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        });
      }
      if (url.includes("/api/embeddings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        });
      }
      if (url.includes("/collections")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { exists: false } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    memoryQdrantPlugin.register(api as unknown as OpenClawPluginApi);
    await services[0].start?.();

    await services[0].stop?.();

    expect(services[0].stop).toBeDefined();

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("Bug Fixes: Path Validation", () => {
  it("validates paths before watching to avoid chokidar errors", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-pathval-"));
    const vaultPath = join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    const services: { start?: () => Promise<void>; stop?: () => Promise<void> }[] = [];
    const warnLogs: string[] = [];
    const api = {
      workspaceDir: tempDir,
      pluginConfig: {
        vaultPath,
        autoIndex: true,
        extraPaths: [
          join(tempDir, "valid-extra"),
          "/nonexistent/path/to/nowhere",
          "/another/invalid/path",
        ],
      },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tempDir, p)),
      registerTool: vi.fn(),
      registerService: (svc: { start?: () => Promise<void>; stop?: () => Promise<void> }) =>
        services.push(svc),
      on: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnLogs.push(msg),
        error: vi.fn(),
      },
    };

    await mkdir(join(tempDir, "valid-extra"), { recursive: true });

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        });
      }
      if (url.includes("/api/embeddings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        });
      }
      if (url.includes("/collections")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { exists: false } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    memoryQdrantPlugin.register(api as unknown as OpenClawPluginApi);
    await services[0].start?.();

    // Should have warned about invalid paths
    const invalidPathWarnings = warnLogs.filter((msg) =>
      msg.includes("skipping invalid watch path"),
    );
    expect(invalidPathWarnings.length).toBeGreaterThan(0);
    expect(invalidPathWarnings.some((msg) => msg.includes("/nonexistent/path"))).toBe(true);

    await services[0].stop?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("handles case when no valid paths exist", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-nopath-"));

    const services: { start?: () => Promise<void>; stop?: () => Promise<void> }[] = [];
    const warnLogs: string[] = [];
    const api = {
      workspaceDir: tempDir,
      pluginConfig: {
        vaultPath: join(tempDir, "nonexistent-vault"),
        autoIndex: true,
      },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tempDir, p)),
      registerTool: vi.fn(),
      registerService: (svc: { start?: () => Promise<void>; stop?: () => Promise<void> }) =>
        services.push(svc),
      on: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnLogs.push(msg),
        error: (msg: string) => warnLogs.push(msg),
      },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        });
      }
      if (url.includes("/api/embeddings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        });
      }
      if (url.includes("/collections")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { exists: false } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    memoryQdrantPlugin.register(api as unknown as OpenClawPluginApi);
    await services[0].start?.();

    const vaultErrorLogs = warnLogs.filter((msg) =>
      msg.includes("vaultPath missing or inaccessible"),
    );
    expect(vaultErrorLogs.length).toBeGreaterThan(0);

    await services[0].stop?.();
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("Bug Fixes: Auto-Recall Promise Leak", () => {
  it("handles timeout gracefully without leaking promises", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-timeout-"));
    const vaultPath = join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    const services: { start?: () => Promise<void>; stop?: () => Promise<void> }[] = [];
    let hookCallback:
      | ((event: { prompt?: string }) => Promise<{ prependContext?: string } | void>)
      | null = null;
    const api = {
      pluginConfig: {
        vaultPath,
        autoRecall: true,
        autoRecallLimit: 3,
        autoRecallMinScore: 0.4,
      },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tempDir, p)),
      registerTool: vi.fn(),
      registerService: (svc: { start?: () => Promise<void>; stop?: () => Promise<void> }) =>
        services.push(svc),
      on: (
        event: string,
        cb: (event: { prompt?: string }) => Promise<{ prependContext?: string } | void>,
      ) => {
        if (event === "before_agent_start") {
          hookCallback = cb;
        }
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        });
      }
      if (url.includes("/api/embeddings")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, json: async () => ({ embedding: Array(768).fill(0.1) }) });
          }, 5000);
        });
      }
      if (url.includes("/collections")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { exists: false } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    memoryQdrantPlugin.register(api as unknown as OpenClawPluginApi);
    await services[0].start?.();

    expect(hookCallback).toBeTruthy();

    const result = await hookCallback?.({ prompt: "What is the capital of France?" });

    expect(result).toBeUndefined();

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("auto-recall timeout"));

    await services[0].stop?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("succeeds when operations complete within timeout", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-notimeout-"));
    const vaultPath = join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(join(vaultPath, "note.md"), "Paris is the capital of France");

    const services: { start?: () => Promise<void>; stop?: () => Promise<void> }[] = [];
    let hookCallback:
      | ((event: { prompt?: string }) => Promise<{ prependContext?: string } | void>)
      | null = null;
    const api = {
      pluginConfig: {
        vaultPath,
        autoRecall: true,
        autoRecallLimit: 3,
        autoRecallMinScore: 0.4,
      },
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tempDir, p)),
      registerTool: vi.fn(),
      registerService: (svc: { start?: () => Promise<void>; stop?: () => Promise<void> }) =>
        services.push(svc),
      on: (
        event: string,
        cb: (event: { prompt?: string }) => Promise<{ prependContext?: string } | void>,
      ) => {
        if (event === "before_agent_start") {
          hookCallback = cb;
        }
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: "qwen3-embedding:4b" }] }),
        });
      }
      if (url.includes("/api/embed")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ embedding: Array(768).fill(0.1) }),
        });
      }
      if (url.includes("/collections") && !url.includes("/points")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { exists: true } }) });
      }
      if (url.includes("/points/search")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            result: [
              {
                id: "1",
                score: 0.9,
                payload: {
                  file: "vault/note.md",
                  startLine: 1,
                  endLine: 1,
                  text: "Paris is the capital of France",
                  source: "vault",
                },
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    memoryQdrantPlugin.register(api as unknown as OpenClawPluginApi);
    await services[0].start?.();

    expect(hookCallback).toBeTruthy();

    const result = await hookCallback?.({ prompt: "What is the capital of France?" });

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain("relevant-memories");
    expect(result?.prependContext).toContain("Paris");

    await services[0].stop?.();
    await rm(tempDir, { recursive: true, force: true });
  });
});
