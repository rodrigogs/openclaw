// ============================================================================
// Types
// ============================================================================

export type MemoryChunk = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export type MemorySearchResult = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  source: "vault" | "workspace" | "captured";
  related?: string[];
  capturedAt?: number; // For recency scoring
};

export const CAPTURED_CATEGORIES = ["preference", "project", "personal", "other"] as const;

export type CapturedCategory = (typeof CAPTURED_CATEGORIES)[number];

export type CapturedMemory = {
  id: string;
  text: string;
  category: CapturedCategory;
  capturedAt: number;
  sessionKey?: string;
};

export type PluginConfig = {
  vaultPath: string;
  workspacePath?: string;
  qdrantUrl?: string;
  collection?: string;
  ollamaUrl?: string;
  embeddingModel?: string;
  autoIndex?: boolean;
  extraPaths?: string[];
  // Watcher settings
  watcherDebounceMs?: number;
  // Auto-recall settings
  autoRecall?: boolean;
  autoRecallLimit?: number;
  autoRecallMinScore?: number;
  // Recency scoring (for captured memories)
  recencyEnabled?: boolean;
  recencyHalfLifeDays?: number;
  recencyWeight?: number;
  // Auto-capture settings
  autoCapture?: boolean;
  autoCaptureMax?: number;
  autoCaptureDupThreshold?: number;
  autoCaptureWindowMs?: number;
  autoCaptureMaxPerWindow?: number;
  // Auto-organization settings
  autoOrganizeOrphans?: boolean;
  orphanThresholdMs?: number;
};
