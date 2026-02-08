/**
 * Shared test helpers for memory-qdrant plugin tests.
 *
 * Provides the watcherState mock, vi.mock setup for chokidar and node:fs/promises,
 * and a factory for creating mock plugin APIs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";

// ============================================================================
// Chokidar watcher mock state (must be hoisted)
// ============================================================================

export const watcherState = vi.hoisted(() => ({
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

// ============================================================================
// Mock setup functions — must be called at module level in each test file
// ============================================================================

export function setupChokidarMock() {
  vi.mock("chokidar", () => ({
    watch: vi.fn(() => {
      watcherState.watchCalled = true;
      const events = {} as any;
      const watcher = {
        on: (event: string, cb: (path?: string) => void) => {
          watcherState.handlers[event] = cb;
          events[event] = cb;
          return watcher;
        },
        emit: (event: string, path: string) => {
          if (events[event]) {
            events[event](path);
          }
        },
        close: vi.fn(async () => {
          watcherState.closeCalled = true;
        }),
      };
      watcherState.instances.push(watcher);
      return watcher;
    }),
  }));
}

export function setupFsMock() {
  vi.mock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
      ...actual,
      stat: vi.fn(actual.stat),
    };
  });
}

// ============================================================================
// Mock fetch helpers
// ============================================================================

export function setupMockFetch() {
  const mockFetch = vi.fn();
  return mockFetch;
}

export function stubFetch(mockFetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
}

export function unstubFetch() {
  vi.unstubAllGlobals();
}

// ============================================================================
// Mock API factory
// ============================================================================

export type MockApi = {
  workspaceDir: string;
  pluginConfig: Record<string, unknown>;
  resolvePath: (p: string) => string;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  registerTool: ReturnType<typeof vi.fn> | ((tool: any) => void);
  registerService: ReturnType<typeof vi.fn> | ((svc: any) => void);
  on: ReturnType<typeof vi.fn> | ((event: string, handler: any) => void);
};

export function createMockApi(overrides: Partial<MockApi> = {}): MockApi {
  return {
    workspaceDir: "/tmp",
    pluginConfig: { vaultPath: "/tmp", autoIndex: false },
    resolvePath: (p: string) => p,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: vi.fn(),
    registerService: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}
