/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import memoryQdrantPlugin, { parseConfig } from "../index.ts";

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

describe("parseConfig", () => {
  it("applies defaults", () => {
    const cfg = parseConfig({ vaultPath: "/vault" }, "/workspace");
    expect(cfg.vaultPath).toBe("/vault");
    expect(cfg.workspacePath).toBe("/workspace");
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoCapture).toBe(false);
  });

  it("throws without vaultPath", () => {
    expect(() => parseConfig({}, "/workspace")).toThrow();
  });

  it("throws on invalid config (null)", () => {
    expect(() => parseConfig(null, "/tmp")).toThrow("memory-qdrant: config required");
  });

  it("throws on invalid config (non-object)", () => {
    expect(() => parseConfig("invalid", "/tmp")).toThrow("memory-qdrant: config required");
  });

  it("throws on missing vaultPath", () => {
    expect(() => parseConfig({}, "/tmp")).toThrow("memory-qdrant: vaultPath is required");
  });
});
