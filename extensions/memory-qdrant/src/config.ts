import type { PluginConfig } from "./types.ts";

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_CONFIG = {
  qdrantUrl: "http://localhost:6333",
  collection: "openclaw-memory",
  ollamaUrl: "http://localhost:11434",
  embeddingModel: "qwen3-embedding:4b",
  autoIndex: true,
  // Watcher settings
  watcherDebounceMs: 1500, // Time to wait before re-indexing after file changes
  // Auto-recall defaults
  autoRecall: true,
  autoRecallLimit: 3,
  autoRecallMinScore: 0.4,
  // Recency scoring defaults (half-life = 30 days)
  recencyEnabled: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.2, // 20% weight on recency
  // Auto-capture defaults (disabled by default for safety)
  autoCapture: false,
  autoCaptureMax: 3,
  autoCaptureDupThreshold: 0.92,
  autoCaptureWindowMs: 5 * 60 * 1000,
  autoCaptureMaxPerWindow: 3,
  // Auto-organization defaults
  autoOrganizeOrphans: true, // Detect and organize orphaned notes
  orphanThresholdMs: 24 * 60 * 60 * 1000, // 24h: note is orphan if no links for 24h
};

export function parseConfig(raw: unknown, workspaceDir: string): Required<PluginConfig> {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory-qdrant: config required");
  }
  const cfg = raw as Partial<PluginConfig>;

  if (!cfg.vaultPath || typeof cfg.vaultPath !== "string") {
    throw new Error("memory-qdrant: vaultPath is required");
  }

  const validLogLevels = ["silent", "error", "warn", "info", "debug"];
  const logLevel =
    typeof cfg.logLevel === "string" && validLogLevels.includes(cfg.logLevel)
      ? cfg.logLevel
      : undefined;

  return {
    vaultPath: cfg.vaultPath,
    workspacePath: cfg.workspacePath || workspaceDir,
    logLevel,
    qdrantUrl: cfg.qdrantUrl || DEFAULT_CONFIG.qdrantUrl,
    collection: cfg.collection || DEFAULT_CONFIG.collection,
    ollamaUrl: cfg.ollamaUrl || DEFAULT_CONFIG.ollamaUrl,
    embeddingModel: cfg.embeddingModel || DEFAULT_CONFIG.embeddingModel,
    autoIndex: cfg.autoIndex !== false,
    extraPaths: Array.isArray(cfg.extraPaths) ? cfg.extraPaths : [],
    // Auto-recall
    autoRecall: cfg.autoRecall ?? DEFAULT_CONFIG.autoRecall,
    autoRecallLimit: cfg.autoRecallLimit ?? DEFAULT_CONFIG.autoRecallLimit,
    autoRecallMinScore: cfg.autoRecallMinScore ?? DEFAULT_CONFIG.autoRecallMinScore,
    // Recency scoring
    recencyEnabled: cfg.recencyEnabled ?? DEFAULT_CONFIG.recencyEnabled,
    recencyHalfLifeDays: cfg.recencyHalfLifeDays ?? DEFAULT_CONFIG.recencyHalfLifeDays,
    recencyWeight: cfg.recencyWeight ?? DEFAULT_CONFIG.recencyWeight,
    // Auto-capture
    autoCapture: cfg.autoCapture ?? DEFAULT_CONFIG.autoCapture,
    autoCaptureMax: cfg.autoCaptureMax ?? DEFAULT_CONFIG.autoCaptureMax,
    autoCaptureDupThreshold: cfg.autoCaptureDupThreshold ?? DEFAULT_CONFIG.autoCaptureDupThreshold,
    autoCaptureWindowMs: cfg.autoCaptureWindowMs ?? DEFAULT_CONFIG.autoCaptureWindowMs,
    autoCaptureMaxPerWindow: cfg.autoCaptureMaxPerWindow ?? DEFAULT_CONFIG.autoCaptureMaxPerWindow,
    // Watcher
    watcherDebounceMs: cfg.watcherDebounceMs ?? DEFAULT_CONFIG.watcherDebounceMs,
    // Orphans
    autoOrganizeOrphans: cfg.autoOrganizeOrphans ?? DEFAULT_CONFIG.autoOrganizeOrphans,
    orphanThresholdMs: cfg.orphanThresholdMs ?? DEFAULT_CONFIG.orphanThresholdMs,
  };
}
