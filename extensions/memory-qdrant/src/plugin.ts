/**
 * OpenClaw Memory (Qdrant + Ollama) Plugin
 *
 * Local memory search with Qdrant vector DB, Ollama embeddings, and Obsidian vault support.
 * Provides memory_search and memory_get tools following the OpenClaw memory plugin contract.
 *
 * Features:
 * - Semantic search across workspace + Obsidian vault
 * - Auto-recall: injects relevant memories before agent starts
 * - Auto-capture: extracts important facts from conversations
 * - 100% local: no external API calls, full privacy
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { watch } from "chokidar";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import type { CapturedCategory, MemorySearchResult } from "./types.ts";
import { shouldCapture, detectCategory } from "./auto-capture.ts";
import { parseConfig } from "./config.ts";
import { indexFile, indexDirectory } from "./indexing.ts";
import { KnowledgeGraph } from "./knowledge-graph.ts";
import { createPluginLogger } from "./logger.ts";
import { OllamaEmbeddings } from "./ollama-embeddings.ts";
import { QdrantClient } from "./qdrant-client.ts";
import { TextIndex } from "./text-index.ts";
import { CAPTURED_CATEGORIES } from "./types.ts";
import { generatePointId, truncateSnippet } from "./utils.ts";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryQdrantPlugin = {
  id: "memory-qdrant",
  name: "Memory (Qdrant + Ollama)",
  description:
    "Local memory search with Qdrant vector DB, Ollama embeddings, Obsidian vault support, auto-recall and auto-capture",
  kind: "memory" as const,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      vaultPath: { type: "string" },
      workspacePath: { type: "string" },
      qdrantUrl: { type: "string" },
      collection: { type: "string" },
      ollamaUrl: { type: "string" },
      embeddingModel: { type: "string" },
      autoIndex: { type: "boolean" },
      extraPaths: { type: "array", items: { type: "string" } },
      // Auto-recall
      autoRecall: { type: "boolean" },
      autoRecallLimit: { type: "number" },
      autoRecallMinScore: { type: "number" },
      // Recency scoring
      recencyEnabled: { type: "boolean" },
      recencyHalfLifeDays: { type: "number" },
      recencyWeight: { type: "number" },
      // Auto-capture
      autoCapture: { type: "boolean" },
      autoCaptureMax: { type: "number" },
      autoCaptureDupThreshold: { type: "number" },
      autoCaptureWindowMs: { type: "number" },
      autoCaptureMaxPerWindow: { type: "number" },
      // Logging
      logLevel: { type: "string", enum: ["silent", "error", "warn", "info", "debug"] },
    },
    required: ["vaultPath"],
  },

  register(api: OpenClawPluginApi) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceDir = (api as any).workspaceDir || process.cwd();
    const cfg = parseConfig(api.pluginConfig, workspaceDir);
    const log = createPluginLogger(api.logger, cfg.logLevel);

    const resolvedVaultPath = api.resolvePath(cfg.vaultPath);
    const resolvedWorkspacePath = api.resolvePath(cfg.workspacePath);

    const extraRoots = cfg.extraPaths.map((entry, index) => ({
      index,
      entry,
      resolved: api.resolvePath(entry),
    }));

    const qdrant = new QdrantClient(cfg.qdrantUrl, cfg.collection);
    const embeddings = new OllamaEmbeddings(cfg.ollamaUrl, cfg.embeddingModel);
    const textIndex = new TextIndex(resolvedWorkspacePath);
    const knowledgeGraph = new KnowledgeGraph(resolvedWorkspacePath);

    let indexing = false;
    let indexingPromise: Promise<void> | null = null;
    let fileWatcher: ReturnType<typeof watch> | null = null;
    let debounceTimeout: NodeJS.Timeout | null = null;

    // Auto-capture rate limiting per conversation
    const captureWindow = new Map<string, number[]>();
    let captureWindowCleanupTimer: NodeJS.Timeout | null = null;

    // Periodic cleanup of stale conversation keys from captureWindow
    const cleanupCaptureWindow = () => {
      const now = Date.now();
      const windowMs = cfg.autoCaptureWindowMs;
      let cleaned = 0;
      for (const [key, timestamps] of captureWindow.entries()) {
        const recent = timestamps.filter((ts) => now - ts <= windowMs);
        if (recent.length === 0) {
          captureWindow.delete(key);
          cleaned++;
        } else if (recent.length < timestamps.length) {
          captureWindow.set(key, recent);
        }
      }
      if (cleaned > 0) {
        log.debug(`memory-qdrant: cleaned ${cleaned} stale conversation keys from captureWindow`);
      }
    };

    // Debounced indexing
    const scheduleIndex = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        debounceTimeout = null;
        void runIndexing();
      }, cfg.watcherDebounceMs);
    };

    async function runIndexing(): Promise<void> {
      if (indexing) {
        return;
      }
      indexing = true;

      try {
        log.debug("memory-qdrant: indexing started");

        const dims = await embeddings.getDimensions();
        await qdrant.ensureCollection(dims);

        let totalChunks = 0;

        // Index Obsidian vault (REQUIRED)
        totalChunks += await indexDirectory(
          resolvedVaultPath,
          "vault/",
          qdrant,
          embeddings,
          log,
          textIndex,
          knowledgeGraph,
        );

        // Index workspace memory files
        const memoryMd = join(resolvedWorkspacePath, "MEMORY.md");
        try {
          await stat(memoryMd);
          totalChunks += await indexFile(
            memoryMd,
            "MEMORY.md",
            qdrant,
            embeddings,
            textIndex,
            knowledgeGraph,
          );
        } catch {
          // MEMORY.md doesn't exist yet
        }

        const memoryDir = join(resolvedWorkspacePath, "memory");
        totalChunks += await indexDirectory(
          memoryDir,
          "memory/",
          qdrant,
          embeddings,
          log,
          textIndex,
          knowledgeGraph,
        );

        // Index extra paths
        for (const extraRoot of extraRoots) {
          const resolved = extraRoot.resolved;
          try {
            const stats = await stat(resolved);
            if (stats.isFile() && resolved.endsWith(".md")) {
              const rel = relative(dirname(resolved), resolved);
              totalChunks += await indexFile(
                resolved,
                `extra/${extraRoot.index}/${rel}`,
                qdrant,
                embeddings,
                textIndex,
                knowledgeGraph,
              );
            } else if (stats.isDirectory()) {
              totalChunks += await indexDirectory(
                resolved,
                `extra/${extraRoot.index}/`,
                qdrant,
                embeddings,
                log,
                textIndex,
                knowledgeGraph,
              );
            }
          } catch {
            // Skip inaccessible paths
          }
        }

        await textIndex.save();
        await knowledgeGraph.save();
        log.info(`memory-qdrant: indexed ${totalChunks} chunks`);
      } catch (err) {
        log.error(`memory-qdrant: indexing failed: ${err}`);
      } finally {
        indexing = false;
      }
    }

    // ========================================================================
    // Tools
    // ========================================================================

    const MemorySearchSchema = Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Number()),
      minScore: Type.Optional(Type.Number()),
    });

    const MemoryGetSchema = Type.Object({
      path: Type.String(),
      from: Type.Optional(Type.Number()),
      lines: Type.Optional(Type.Number()),
    });

    const CapturedCategorySchema = Type.Union(
      CAPTURED_CATEGORIES.map((category) => Type.Literal(category)),
    );

    const MemoryCapturedListSchema = Type.Object({
      category: Type.Optional(CapturedCategorySchema),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.String()),
    });

    const MemoryCapturedDeleteSchema = Type.Object({
      id: Type.String(),
    });

    const MemoryCapturedExportSchema = Type.Object({
      category: Type.Optional(CapturedCategorySchema),
      limit: Type.Optional(Type.Number()),
      title: Type.Optional(Type.String()),
    });

    const MemoryOrganizeSchema = Type.Object({
      dryRun: Type.Optional(Type.Boolean()),
    });

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
        parameters: MemorySearchSchema,
        execute: async (_toolCallId, params) => {
          const query = readStringParam(params, "query", { required: true });
          const maxResults = readNumberParam(params, "maxResults") ?? 5;
          const minScore = readNumberParam(params, "minScore") ?? 0.5;

          try {
            let vectorResults: MemorySearchResult[] = [];
            let embeddingError: string | null = null;

            // Try vector search (may fail if Ollama is down)
            try {
              const vector = await embeddings.embed(query);
              vectorResults = await qdrant.search(vector, maxResults, minScore);
            } catch (err) {
              embeddingError = err instanceof Error ? err.message : String(err);
              log.warn(
                `memory-qdrant: vector search failed, falling back to text-only: ${embeddingError}`,
              );
            }

            // Always do text search for robustness
            const textHits = textIndex.search(query, Math.max(maxResults * 4, 10));
            const maxTextScore =
              textHits.reduce((max, hit) => Math.max(max, hit.score || 0), 0) || 1;

            const textResults: MemorySearchResult[] = textHits.map((hit: unknown) => {
              const h = hit as {
                id?: unknown;
                file?: string;
                startLine?: number;
                endLine?: number;
                text?: string;
                score?: number;
                source?: string;
                category?: string;
              };
              return {
                id: String(h.id),
                file: h.file!,
                startLine: h.startLine ?? 1,
                endLine: h.endLine ?? 1,
                snippet: truncateSnippet(h.text || ""),
                score: (h.score || 0) / maxTextScore,
                source:
                  h.source ||
                  (h.file?.startsWith("vault/")
                    ? "vault"
                    : h.file?.startsWith("captured/")
                      ? "captured"
                      : "workspace"),
                category: h.category || "note",
              };
            });

            // If vector search failed, use text-only; otherwise blend both
            const vectorWeight = embeddingError ? 0 : 0.7;
            const textWeight = embeddingError ? 1 : 0.3;

            const merged = new Map<
              string,
              { res: MemorySearchResult; vectorScore?: number; textScore?: number }
            >();

            for (const r of vectorResults) {
              merged.set(r.id, { res: r, vectorScore: r.score });
            }

            for (const r of textResults) {
              const existing = merged.get(r.id);
              if (existing) {
                existing.textScore = r.score;
              } else {
                merged.set(r.id, { res: r, textScore: r.score });
              }
            }

            const results = Array.from(merged.values())
              .map(({ res, vectorScore, textScore }) => {
                // Enrich with related links (Graph)
                const related = knowledgeGraph.getRelated(res.file);
                const relatedFiles = [...related.links, ...related.backlinks].slice(0, 3);

                // Apply recency decay for captured memories (exponential decay)
                let recencyScore = 1.0;
                if (cfg.recencyEnabled && res.capturedAt) {
                  const ageMs = Date.now() - res.capturedAt;
                  const ageDays = ageMs / (24 * 60 * 60 * 1000);
                  const halfLife = cfg.recencyHalfLifeDays;
                  recencyScore = Math.exp((-Math.LN2 * ageDays) / halfLife);
                }

                // Combine vector + text + recency
                const baseScore = (vectorScore ?? 0) * vectorWeight + (textScore ?? 0) * textWeight;
                const finalScore =
                  res.capturedAt && cfg.recencyEnabled
                    ? baseScore * (1 - cfg.recencyWeight) + recencyScore * cfg.recencyWeight
                    : baseScore;

                return {
                  ...res,
                  score: finalScore,
                  related: relatedFiles.length > 0 ? relatedFiles : undefined,
                };
              })
              .toSorted((a, b) => b.score - a.score)
              .slice(0, maxResults);

            return jsonResult({
              results: results.map((r) => ({
                file: r.file,
                startLine: r.startLine,
                endLine: r.endLine,
                snippet: r.snippet,
                score: r.score,
                source: r.source,
                related: r.related,
              })),
              provider: "ollama",
              model: cfg.embeddingModel,
              hybrid: !embeddingError,
              embeddingFailed: embeddingError ? true : undefined,
              fallbackMode: embeddingError ? "text-only" : undefined,
              error: embeddingError || undefined,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`memory-qdrant: search error: ${message}`);
            return jsonResult({ results: [], disabled: false, error: message });
          }
        },
      },
      { names: ["memory_search"] },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description:
          "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
        parameters: MemoryGetSchema,
        execute: async (_toolCallId, params) => {
          const relPath = readStringParam(params, "path", { required: true });
          const fromLine = readNumberParam(params, "from", { integer: true }) ?? 1;
          const lineCount = readNumberParam(params, "lines", { integer: true });

          // Security: only allow reading from indexed sources
          const allowedPrefixes = ["MEMORY.md", "memory/", "vault/", "extra/", "captured/"];
          if (!allowedPrefixes.some((prefix) => relPath.startsWith(prefix))) {
            return jsonResult({
              path: relPath,
              text: "",
              error: "Access denied: path outside indexed sources",
            });
          }

          // Captured memories are stored in Qdrant, not files
          if (relPath.startsWith("captured/")) {
            return jsonResult({
              path: relPath,
              text: "(captured memory - stored in vector DB only)",
              note: "Use memory_search to find captured memories",
            });
          }

          try {
            let fullPath: string;
            if (relPath.startsWith("vault/")) {
              fullPath = join(resolvedVaultPath, relPath.slice(6));
            } else if (relPath.startsWith("extra/")) {
              const parts = relPath.split("/").slice(1);
              const index = Number(parts.shift());
              const root = extraRoots.find((entry) => entry.index === index);
              if (!root) {
                return jsonResult({
                  path: relPath,
                  text: "",
                  error: "Unknown extra path index",
                });
              }
              fullPath = join(root.resolved, ...parts);
            } else {
              fullPath = join(resolvedWorkspacePath, relPath);
            }

            const content = await readFile(fullPath, "utf-8");
            const lines = content.split("\n");

            const start = Math.max(0, fromLine - 1);
            const end = lineCount ? Math.min(lines.length, start + lineCount) : lines.length;
            const text = lines.slice(start, end).join("\n");

            return jsonResult({
              path: relPath,
              from: fromLine,
              lines: end - start,
              text,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ path: relPath, text: "", error: message });
          }
        },
      },
      { names: ["memory_get"] },
    );

    api.registerTool(
      {
        name: "memory_captured_list",
        label: "Captured Memory List",
        description: "List captured memories stored in Qdrant.",
        parameters: MemoryCapturedListSchema,
        execute: async (_toolCallId, params) => {
          const category = params.category as CapturedCategory | undefined;
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
          const offset = readStringParam(params, "offset", { allowEmpty: true });

          try {
            const { items, nextOffset } = await qdrant.listCaptured(
              category,
              limit,
              offset || undefined,
            );

            return jsonResult({
              items,
              nextOffset,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ items: [], error: message });
          }
        },
      },
      { names: ["memory_captured_list"] },
    );

    api.registerTool(
      {
        name: "memory_captured_delete",
        label: "Captured Memory Delete",
        description: "Delete a captured memory by id.",
        parameters: MemoryCapturedDeleteSchema,
        execute: async (_toolCallId, params) => {
          const id = readStringParam(params, "id", { required: true });

          try {
            await qdrant.deleteCaptured(id);
            return jsonResult({ id, deleted: true });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ id, deleted: false, error: message });
          }
        },
      },
      { names: ["memory_captured_delete"] },
    );

    api.registerTool(
      {
        name: "memory_captured_export",
        label: "Captured Memory Export",
        description: "Export captured memories to the Obsidian inbox.",
        parameters: MemoryCapturedExportSchema,
        execute: async (_toolCallId, params) => {
          const category = params.category as CapturedCategory | undefined;
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 100;
          const title = readStringParam(params, "title", { allowEmpty: true })?.trim();

          try {
            const { items } = await qdrant.listCaptured(category, limit);
            const inboxDir = join(resolvedVaultPath, "00 Inbox");
            await mkdir(inboxDir, { recursive: true });

            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, "-");
            const filename = `${title?.length ? title : "captured-memories"}-${timestamp}.md`;
            const fullPath = join(inboxDir, filename);

            const header = `# ${title?.length ? title : "Captured memories"}\n\n`;
            const meta = `- Exported: ${now.toISOString()}\n- Count: ${items.length}\n\n`;
            const body = items
              .map((item) => {
                const date = item.capturedAt ? new Date(item.capturedAt).toISOString() : "";
                return `- **${item.category}** (${date}) ${item.text}`;
              })
              .join("\n");

            await writeFile(fullPath, `${header}${meta}${body}\n`);

            return jsonResult({ path: `vault/00 Inbox/${filename}`, count: items.length });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ error: message });
          }
        },
      },
      { names: ["memory_captured_export"] },
    );

    api.registerTool(
      {
        name: "memory_organize",
        label: "Memory Organize",
        description:
          "Analyze the vault for orphaned files and suggest improvements. Uses Graph Knowledge to find notes with no backlinks.",
        parameters: MemoryOrganizeSchema,
        execute: async (_toolCallId, params) => {
          const _dryRun = params.dryRun !== false;

          try {
            // Find orphans (files with no backlinks)
            // We iterate all nodes in the graph
            // Since knowledgeGraph is private, we need to expose a method or iterate manually if we exported it
            // Ah, KnowledgeGraph is a class in this module, we can add a method there.

            // Let's add getOrphans to KnowledgeGraph class first (I'll do that in a separate edit block to keep this clean)
            // For now, assume it exists
            const orphans = knowledgeGraph.getOrphans();

            // Filter out daily notes (they naturally might not have backlinks initially)
            // Assuming daily notes are in "01 Journal/Daily" or "memory/"
            const meaningfulOrphans = orphans.filter(
              (f) =>
                !f.includes("01 Journal/") && !f.includes("memory/") && !f.includes("captured/"),
            );

            // In a real implementation, we could ask the LLM to suggest links or move files
            // For this first version, we just report them.

            return jsonResult({
              orphans: meaningfulOrphans,
              count: meaningfulOrphans.length,
              note: "These files have no incoming links. Consider linking them from an Index note.",
            });
          } catch (err) {
            return jsonResult({ error: String(err) });
          }
        },
      },
      { names: ["memory_organize"] },
    );

    // ========================================================================
    // Lifecycle Hooks: Auto-Recall & Auto-Capture
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        // Skip if prompt is too short or already has memories
        if (!event.prompt || event.prompt.length < 10) {
          return;
        }
        if (event.prompt.includes("<relevant-memories>")) {
          return;
        }

        try {
          // Timeout protection: max 3 seconds for auto-recall (don't block agent)
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("auto-recall timeout")), 3000);
          });

          const vector = await Promise.race([embeddings.embed(event.prompt), timeoutPromise]);

          const results = await Promise.race([
            qdrant.search(vector, cfg.autoRecallLimit, cfg.autoRecallMinScore),
            timeoutPromise,
          ]);

          if (results.length === 0) {
            return;
          }

          const memoryContext = results
            .map(
              (r) =>
                `- [${r.source}/${r.file}] ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`,
            )
            .join("\n");

          log.debug(`memory-qdrant: auto-recall injecting ${results.length} memories`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>\n\n`,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("timeout")) {
            log.warn(`memory-qdrant: auto-recall timeout (proceeding without memories)`);
          } else {
            log.warn(`memory-qdrant: auto-recall failed: ${errMsg}`);
          }
          // Don't return anything; proceed without memories
        }
      });
    }

    // Auto-capture: extract and store important information on message_received
    if (cfg.autoCapture) {
      log.debug("memory-qdrant: registering message_received hook for auto-capture");

      api.on("message_received", async (event, ctx) => {
        try {
          const text = event?.content;
          if (!text || typeof text !== "string") {
            return;
          }

          // Filter for capturable content
          if (!shouldCapture(text)) {
            return;
          }

          // Rate limit per conversation/session
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const key = ctx?.conversationId || (ctx as any)?.sessionKey || event?.from || "default";
          const now = Date.now();
          const windowMs = cfg.autoCaptureWindowMs;
          const maxPerWindow = cfg.autoCaptureMaxPerWindow;
          const history = captureWindow.get(key) || [];
          const pruned = history.filter((ts) => now - ts <= windowMs);
          if (pruned.length >= maxPerWindow) {
            captureWindow.set(key, pruned);
            return;
          }
          pruned.push(now);
          captureWindow.set(key, pruned);

          const vector = await embeddings.embed(text);

          // Check for duplicates
          const dup = await qdrant.searchForDuplicates(vector, cfg.autoCaptureDupThreshold);
          if (dup.error) {
            log.warn(`memory-qdrant: duplicate check failed (proceeding anyway): ${dup.error}`);
          }
          if (dup.exists) {
            log.debug(
              `memory-qdrant: skipping duplicate (${dup.score.toFixed(2)}): ${text.slice(0, 50)}...`,
            );
            return;
          }

          const category = detectCategory(text);
          const id = generatePointId(`${Date.now()}-${text}`);
          const memory = {
            id,
            text,
            category,
            capturedAt: Date.now(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionKey: (ctx as any)?.sessionKey,
          };

          await qdrant.upsertCaptured(memory, vector);
          log.debug(`memory-qdrant: auto-captured [${category}]: ${text.slice(0, 50)}...`);
        } catch (err) {
          log.warn(`memory-qdrant: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service (File Watcher + Initial Index)
    // ========================================================================

    api.registerService({
      id: "memory-qdrant-indexer",
      start: async () => {
        const features = [];
        if (cfg.autoRecall) {
          features.push("auto-recall");
        }
        if (cfg.autoCapture) {
          features.push("auto-capture");
        }

        log.info(
          `memory-qdrant: initialized (vault: ${resolvedVaultPath}, collection: ${cfg.collection}, features: [${features.join(", ") || "none"}])`,
        );

        // Health check: verify Qdrant and Ollama are reachable before proceeding
        try {
          log.debug("memory-qdrant: checking Qdrant connectivity...");
          await qdrant.healthCheck();
          log.info(`memory-qdrant: Qdrant OK at ${cfg.qdrantUrl}`);
        } catch (err) {
          log.error(
            `memory-qdrant: Qdrant not reachable at ${cfg.qdrantUrl} — is it running? Error: ${err}`,
          );
          return;
        }

        try {
          log.debug("memory-qdrant: checking Ollama connectivity...");
          await embeddings.healthCheck();
          log.info(
            `memory-qdrant: Ollama OK at ${cfg.ollamaUrl}, model "${cfg.embeddingModel}" available`,
          );
        } catch (err) {
          log.error(
            `memory-qdrant: Ollama not reachable at ${cfg.ollamaUrl} or model "${cfg.embeddingModel}" missing — Error: ${err}`,
          );
          return;
        }

        await textIndex.load();
        await knowledgeGraph.load();

        if (cfg.autoIndex) {
          try {
            await stat(resolvedVaultPath);
          } catch {
            log.error(`memory-qdrant: vaultPath missing or inaccessible: ${resolvedVaultPath}`);
            return;
          }

          // Initial indexing
          indexingPromise = runIndexing();

          // Watch for changes (validate paths first)
          const candidatePaths = [
            resolvedVaultPath,
            join(resolvedWorkspacePath, "MEMORY.md"),
            join(resolvedWorkspacePath, "memory"),
            ...extraRoots.map((entry) => entry.resolved),
          ];

          // Validate paths before watching to avoid chokidar issues
          const watchPaths: string[] = [];
          for (const path of candidatePaths) {
            try {
              await stat(path);
              watchPaths.push(path);
            } catch {
              log.warn(`memory-qdrant: skipping invalid watch path: ${path}`);
            }
          }

          if (watchPaths.length === 0) {
            log.warn("memory-qdrant: no valid paths to watch");
          } else {
            fileWatcher = watch(watchPaths, {
              ignored: /(^|[/\\])\../, // Ignore dotfiles
              persistent: true,
              ignoreInitial: true,
            });

            fileWatcher.on("add", scheduleIndex);
            fileWatcher.on("change", scheduleIndex);
            fileWatcher.on("unlink", scheduleIndex);

            log.debug(`memory-qdrant: watching ${watchPaths.length} paths for changes`);
          }
        }

        // Start periodic captureWindow cleanup (every 5 minutes)
        if (cfg.autoCapture) {
          captureWindowCleanupTimer = setInterval(cleanupCaptureWindow, 5 * 60 * 1000);
        }
      },
      stop: async () => {
        if (captureWindowCleanupTimer) {
          clearInterval(captureWindowCleanupTimer);
          captureWindowCleanupTimer = null;
        }
        if (debounceTimeout) {
          clearTimeout(debounceTimeout);
          debounceTimeout = null;
        }
        if (fileWatcher) {
          await fileWatcher.close();
          fileWatcher = null;
        }
        if (indexingPromise) {
          await indexingPromise;
        }
        await textIndex.save();
        await knowledgeGraph.save();
        log.info("memory-qdrant: stopped");
      },
    });
  },
};

export default memoryQdrantPlugin;
