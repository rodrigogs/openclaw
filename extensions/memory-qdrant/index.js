"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaEmbeddings = exports.QdrantClient = void 0;
exports.parseConfig = parseConfig;
exports.shouldCapture = shouldCapture;
exports.detectCategory = detectCategory;
exports.chunkText = chunkText;
exports.indexFile = indexFile;
exports.findMarkdownFiles = findMarkdownFiles;
exports.indexDirectory = indexDirectory;
exports.truncateSnippet = truncateSnippet;
const typebox_1 = require("@sinclair/typebox");
const chokidar_1 = require("chokidar");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const plugin_sdk_1 = require("openclaw/plugin-sdk");
const CAPTURED_CATEGORIES = ["preference", "project", "personal", "other"];
// ============================================================================
// Configuration
// ============================================================================
const DEFAULT_CONFIG = {
    qdrantUrl: "http://localhost:6333",
    collection: "openclaw-memory",
    ollamaUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
    autoIndex: true,
    // Auto-recall defaults
    autoRecall: true,
    autoRecallLimit: 3,
    autoRecallMinScore: 0.4,
    // Auto-capture defaults (disabled by default for safety)
    autoCapture: false,
    autoCaptureMax: 3,
    autoCaptureDupThreshold: 0.92,
    autoCaptureWindowMs: 5 * 60 * 1000,
    autoCaptureMaxPerWindow: 3,
};
function parseConfig(raw, workspaceDir) {
    if (!raw || typeof raw !== "object") {
        throw new Error("memory-qdrant: config required");
    }
    const cfg = raw;
    if (!cfg.vaultPath || typeof cfg.vaultPath !== "string") {
        throw new Error("memory-qdrant: vaultPath is required");
    }
    return {
        vaultPath: cfg.vaultPath,
        workspacePath: cfg.workspacePath || workspaceDir,
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
        // Auto-capture
        autoCapture: cfg.autoCapture ?? DEFAULT_CONFIG.autoCapture,
        autoCaptureMax: cfg.autoCaptureMax ?? DEFAULT_CONFIG.autoCaptureMax,
        autoCaptureDupThreshold: cfg.autoCaptureDupThreshold ?? DEFAULT_CONFIG.autoCaptureDupThreshold,
        autoCaptureWindowMs: cfg.autoCaptureWindowMs ?? DEFAULT_CONFIG.autoCaptureWindowMs,
        autoCaptureMaxPerWindow: cfg.autoCaptureMaxPerWindow ?? DEFAULT_CONFIG.autoCaptureMaxPerWindow,
    };
}
// ============================================================================
// Auto-Capture: Trigger Patterns
// ============================================================================
/**
 * Patterns that indicate text worth capturing.
 * Includes both English and Portuguese patterns.
 */
const MEMORY_TRIGGERS = [
    // Explicit memory requests
    /\b(remember|remind\s+me|don['’]?t\s+forget|please\s+remember|note\s+this|save\s+this|log\s+this|track\s+this|remember\s+that|lembra|lembre|guarda|salva|anota|memoriza|memorizar|memoria|não\s+esquece|nao\s+esquece|não\s+esquecer|nao\s+esquecer|por\s+favor\s+lembra|por\s+favor\s+lembre)\b/i,
    // Preferences
    /\b(prefer|prefiro|gosto|não gosto|odeio|adoro|quero|não quero)\b/i,
    /\b(i like|i love|i hate|i prefer|i want|i need)\b/i,
    // Decisions
    /\b(decidimos|decidiu|vamos usar|escolhi|optei)\b/i,
    /\b(decided|will use|going to use|chose|picked)\b/i,
    // Entities (phone, email, names)
    /\+\d{10,}/, // Phone numbers
    /[\w.-]+@[\w.-]+\.\w{2,}/, // Emails
    /\b(meu nome é|me chamo|sou o|sou a)\b/i,
    /\b(my name is|i am called|call me)\b/i,
    // Facts with possessives
    /\b(meu|minha|meus|minhas)\s+\w+\s+(é|são|fica|mora)/i,
    /\b(my|our)\s+\w+\s+(is|are|lives|works)/i,
    // Important qualifiers
    /\b(sempre|nunca|importante|crucial|essencial)\b/i,
    /\b(always|never|important|crucial|essential)\b/i,
    // Timezone and location
    /\b(moro em|trabalho em|fuso horário|timezone)\b/i,
    /\b(i live in|i work at|my timezone)\b/i,
];
/**
 * Patterns that indicate text should NOT be captured.
 */
const MEMORY_EXCLUSIONS = [
    // System/tool output
    /<[^>]+>/, // XML tags
    /```[\s\S]*?```/, // Code blocks (non-greedy to handle multiple blocks)
    /^\s*[-*]\s+/m, // Markdown lists (likely tool output)
    // Agent confirmations
    /\b(pronto|feito|ok|certo|entendi|anotado)\b.*!?\s*$/i,
    /\b(done|got it|noted|understood|saved)\b.*!?\s*$/i,
    // Questions (don't capture questions, capture answers)
    /\?\s*$/,
    // Very short or very long
    /^.{0,14}$/, // Less than 15 chars
    /^.{501,}$/, // More than 500 chars
];
/**
 * Check if text should be captured as a memory.
 */
function shouldCapture(text) {
    // Check exclusions first (faster)
    for (const pattern of MEMORY_EXCLUSIONS) {
        if (pattern.test(text))
            return false;
    }
    // Skip if already contains memory injection
    if (text.includes("<relevant-memories>"))
        return false;
    // Skip emoji-heavy content (likely agent output)
    const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
    if (emojiCount > 3)
        return false;
    // Check if any trigger matches
    for (const pattern of MEMORY_TRIGGERS) {
        if (pattern.test(text))
            return true;
    }
    return false;
}
/**
 * Detect memory category based on content.
 */
function detectCategory(text) {
    const lower = text.toLowerCase();
    if (/prefer|prefiro|gosto|like|love|hate|want|quero|odeio|adoro/i.test(lower)) {
        return "preference";
    }
    if (/decidimos|decided|will use|vamos usar|escolhi|chose|projeto|project|feature|roadmap|meta|objetivo/i.test(lower)) {
        return "project";
    }
    if (/\+\d{10,}|@[\w.-]+\.\w+|nome é|name is|chamo|called|moro|sou|trabalho/i.test(lower)) {
        return "personal";
    }
    return "other";
}
// ============================================================================
// Qdrant Client
// ============================================================================
class QdrantClient {
    url;
    collection;
    constructor(url, collection) {
        this.url = url;
        this.collection = collection;
    }
    async ensureCollection(vectorSize) {
        const collections = await this.fetch("/collections");
        const exists = collections.result.collections.some((c) => c.name === this.collection);
        if (exists)
            return;
        await this.fetch(`/collections/${this.collection}`, {
            method: "PUT",
            body: JSON.stringify({
                vectors: {
                    size: vectorSize,
                    distance: "Cosine",
                },
            }),
        });
    }
    async deleteByFile(file) {
        await this.fetch(`/collections/${this.collection}/points/delete`, {
            method: "POST",
            body: JSON.stringify({
                filter: {
                    must: [{ key: "file", match: { value: file } }],
                },
            }),
        });
    }
    async upsert(chunks, embeddings) {
        if (chunks.length === 0)
            return;
        const points = chunks.map((chunk, i) => ({
            id: chunk.id,
            vector: embeddings[i],
            payload: {
                file: chunk.file,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                text: chunk.text,
                hash: chunk.hash,
            },
        }));
        await this.fetch(`/collections/${this.collection}/points`, {
            method: "PUT",
            body: JSON.stringify({ points }),
        });
    }
    async upsertCaptured(memory, embedding) {
        const point = {
            id: memory.id,
            vector: embedding,
            payload: {
                file: `captured/${memory.category}`,
                startLine: 1,
                endLine: 1,
                text: memory.text,
                hash: (0, node_crypto_1.createHash)("sha256").update(memory.text).digest("hex"),
                category: memory.category,
                capturedAt: memory.capturedAt,
                sessionKey: memory.sessionKey,
                source: "captured",
            },
        };
        await this.fetch(`/collections/${this.collection}/points`, {
            method: "PUT",
            body: JSON.stringify({ points: [point] }),
        });
    }
    async listCaptured(category, limit = 20, offset) {
        const filter = category
            ? {
                must: [{ key: "category", match: { value: category } }],
            }
            : {
                should: CAPTURED_CATEGORIES.map((cat) => ({
                    key: "category",
                    match: { value: cat },
                })),
            };
        const response = await this.fetch(`/collections/${this.collection}/points/scroll`, {
            method: "POST",
            body: JSON.stringify({
                limit,
                offset,
                filter,
                with_payload: ["text", "category", "capturedAt", "sessionKey"],
                with_vectors: false,
            }),
        });
        const items = response.result.points
            .map((point) => ({
            id: String(point.id),
            text: point.payload?.text ?? "",
            category: point.payload?.category ?? "other",
            capturedAt: point.payload?.capturedAt ?? 0,
            sessionKey: point.payload?.sessionKey,
        }))
            .filter((item) => item.text.length > 0);
        return { items, nextOffset: response.result.next_page_offset };
    }
    async deleteCaptured(id) {
        await this.fetch(`/collections/${this.collection}/points/delete`, {
            method: "POST",
            body: JSON.stringify({ points: [id] }),
        });
    }
    async search(vector, limit, scoreThreshold) {
        const response = await this.fetch(`/collections/${this.collection}/points/search`, {
            method: "POST",
            body: JSON.stringify({
                vector,
                limit,
                score_threshold: scoreThreshold,
                with_payload: true,
            }),
        });
        return response.result.map((hit) => ({
            file: hit.payload.file,
            startLine: hit.payload.startLine,
            endLine: hit.payload.endLine,
            snippet: truncateSnippet(hit.payload.text),
            score: hit.score,
            source: hit.payload.source === "captured"
                ? "captured"
                : hit.payload.file.startsWith("vault/")
                    ? "vault"
                    : "workspace",
        }));
    }
    async searchForDuplicates(vector, threshold) {
        try {
            const response = await this.fetch(`/collections/${this.collection}/points/search`, {
                method: "POST",
                body: JSON.stringify({
                    vector,
                    limit: 1,
                    score_threshold: threshold,
                    with_payload: ["text"],
                }),
            });
            if (response.result.length > 0) {
                return {
                    exists: true,
                    score: response.result[0].score,
                    text: response.result[0].payload.text,
                };
            }
            return { exists: false, score: 0 };
        }
        catch (err) {
            // Return error for caller to log if needed (allows capture to proceed)
            return { exists: false, score: 0, error: String(err) };
        }
    }
    async fetch(path, init) {
        const url = `${this.url}${path}`;
        const response = await fetch(url, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...init?.headers,
            },
        });
        if (!response.ok) {
            throw new Error(`Qdrant ${init?.method || "GET"} ${path}: ${response.status}`);
        }
        return response.json();
    }
}
exports.QdrantClient = QdrantClient;
// ============================================================================
// Ollama Embeddings
// ============================================================================
class OllamaEmbeddings {
    url;
    model;
    constructor(url, model) {
        this.url = url;
        this.model = model;
    }
    async embed(text) {
        const response = await fetch(`${this.url}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                prompt: text,
            }),
        });
        if (!response.ok) {
            throw new Error(`Ollama embed: ${response.status}`);
        }
        const data = (await response.json());
        return data.embedding;
    }
    async embedBatch(texts) {
        return Promise.all(texts.map((text) => this.embed(text)));
    }
    async getDimensions() {
        const testVector = await this.embed("test");
        return testVector.length;
    }
}
exports.OllamaEmbeddings = OllamaEmbeddings;
// ============================================================================
// Chunking & Indexing
// ============================================================================
function chunkText(text, targetWords = 400, overlapWords = 80) {
    const MAX_LINE_CHARS = 2000;
    const rawLines = text.split("\n");
    const lines = [];
    for (const line of rawLines) {
        if (line.length <= MAX_LINE_CHARS) {
            lines.push(line);
            continue;
        }
        for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
            lines.push(line.slice(i, i + MAX_LINE_CHARS));
        }
    }
    const chunks = [];
    let currentChunk = [];
    let currentWordCount = 0;
    let chunkStartLine = 1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineWords = line.split(/\s+/).filter(Boolean).length;
        currentChunk.push(line);
        currentWordCount += lineWords;
        if (currentWordCount >= targetWords || i === lines.length - 1) {
            if (currentChunk.length > 0) {
                const text = currentChunk.join("\n");
                if (text.trim().length > 0) {
                    chunks.push({
                        id: "", // Will be set during indexing
                        file: "", // Will be set during indexing
                        startLine: chunkStartLine,
                        endLine: chunkStartLine + currentChunk.length - 1,
                        text,
                        hash: "",
                    });
                }
            }
            // Overlap: keep last ~overlapWords worth of lines
            if (i < lines.length - 1 && overlapWords > 0) {
                let overlapCount = 0;
                const overlapLines = [];
                for (let j = currentChunk.length - 1; j >= 0; j--) {
                    const words = currentChunk[j].split(/\s+/).filter(Boolean).length;
                    overlapCount += words;
                    overlapLines.unshift(currentChunk[j]);
                    if (overlapCount >= overlapWords)
                        break;
                }
                chunkStartLine = chunkStartLine + currentChunk.length - overlapLines.length;
                currentChunk = overlapLines;
                currentWordCount = overlapCount;
            }
            else {
                chunkStartLine = chunkStartLine + currentChunk.length;
                currentChunk = [];
                currentWordCount = 0;
            }
        }
    }
    return chunks;
}
async function indexFile(filePath, relPath, qdrant, embeddings) {
    const content = await (0, promises_1.readFile)(filePath, "utf-8");
    const chunks = chunkText(content);
    if (chunks.length === 0)
        return 0;
    // Set file and compute IDs
    const processedChunks = chunks.map((chunk) => {
        const id = (0, node_crypto_1.createHash)("sha256")
            .update(`${relPath}:${chunk.startLine}-${chunk.endLine}`)
            .digest("hex")
            .slice(0, 32);
        const hash = (0, node_crypto_1.createHash)("sha256").update(chunk.text).digest("hex");
        return { ...chunk, id, file: relPath, hash };
    });
    // Delete old chunks for this file
    await qdrant.deleteByFile(relPath);
    // Generate embeddings and upsert
    const vectors = await embeddings.embedBatch(processedChunks.map((c) => c.text));
    await qdrant.upsert(processedChunks, vectors);
    return processedChunks.length;
}
async function findMarkdownFiles(dir) {
    const files = [];
    try {
        const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = (0, node_path_1.join)(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await findMarkdownFiles(fullPath)));
            }
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                files.push(fullPath);
            }
        }
    }
    catch (err) {
        // Ignore permission errors, missing dirs
    }
    return files;
}
async function indexDirectory(dir, prefix, qdrant, embeddings, logger) {
    const files = await findMarkdownFiles(dir);
    let totalChunks = 0;
    for (const file of files) {
        const relPath = `${prefix}${(0, node_path_1.relative)(dir, file)}`;
        try {
            const chunks = await indexFile(file, relPath, qdrant, embeddings);
            totalChunks += chunks;
        }
        catch (err) {
            logger.info(`memory-qdrant: failed to index ${relPath}: ${err}`);
        }
    }
    return totalChunks;
}
function truncateSnippet(text, maxChars = 700) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + "...";
}
// ============================================================================
// Plugin Definition
// ============================================================================
const memoryQdrantPlugin = {
    id: "memory-qdrant",
    name: "Memory (Qdrant + Ollama)",
    description: "Local memory search with Qdrant vector DB, Ollama embeddings, Obsidian vault support, auto-recall and auto-capture",
    kind: "memory",
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
            // Auto-capture
            autoCapture: { type: "boolean" },
            autoCaptureMax: { type: "number" },
            autoCaptureDupThreshold: { type: "number" },
            autoCaptureWindowMs: { type: "number" },
            autoCaptureMaxPerWindow: { type: "number" },
        },
        required: ["vaultPath"],
    },
    register(api) {
        const workspaceDir = api.workspaceDir || process.cwd();
        const cfg = parseConfig(api.pluginConfig, workspaceDir);
        const resolvedVaultPath = api.resolvePath(cfg.vaultPath);
        const resolvedWorkspacePath = api.resolvePath(cfg.workspacePath);
        const extraRoots = cfg.extraPaths.map((entry, index) => ({
            index,
            entry,
            resolved: api.resolvePath(entry),
        }));
        const qdrant = new QdrantClient(cfg.qdrantUrl, cfg.collection);
        const embeddings = new OllamaEmbeddings(cfg.ollamaUrl, cfg.embeddingModel);
        let indexing = false;
        let indexingPromise = null;
        let fileWatcher = null;
        // Auto-capture rate limiting per conversation
        const captureWindow = new Map();
        // Debounced indexing
        const scheduleIndex = (() => {
            let timeout = null;
            return () => {
                if (timeout)
                    clearTimeout(timeout);
                timeout = setTimeout(() => runIndexing(), 1500);
            };
        })();
        async function runIndexing() {
            if (indexing)
                return;
            indexing = true;
            try {
                api.logger.info("memory-qdrant: indexing started");
                const dims = await embeddings.getDimensions();
                await qdrant.ensureCollection(dims);
                let totalChunks = 0;
                // Index Obsidian vault (REQUIRED)
                totalChunks += await indexDirectory(resolvedVaultPath, "vault/", qdrant, embeddings, api.logger);
                // Index workspace memory files
                const memoryMd = (0, node_path_1.join)(resolvedWorkspacePath, "MEMORY.md");
                try {
                    await (0, promises_1.stat)(memoryMd);
                    totalChunks += await indexFile(memoryMd, "MEMORY.md", qdrant, embeddings);
                }
                catch {
                    // MEMORY.md doesn't exist yet
                }
                const memoryDir = (0, node_path_1.join)(resolvedWorkspacePath, "memory");
                totalChunks += await indexDirectory(memoryDir, "memory/", qdrant, embeddings, api.logger);
                // Index extra paths
                for (const extraRoot of extraRoots) {
                    const resolved = extraRoot.resolved;
                    try {
                        const stats = await (0, promises_1.stat)(resolved);
                        if (stats.isFile() && resolved.endsWith(".md")) {
                            const rel = (0, node_path_1.relative)((0, node_path_1.dirname)(resolved), resolved);
                            totalChunks += await indexFile(resolved, `extra/${extraRoot.index}/${rel}`, qdrant, embeddings);
                        }
                        else if (stats.isDirectory()) {
                            totalChunks += await indexDirectory(resolved, `extra/${extraRoot.index}/`, qdrant, embeddings, api.logger);
                        }
                    }
                    catch {
                        // Skip inaccessible paths
                    }
                }
                api.logger.info(`memory-qdrant: indexed ${totalChunks} chunks`);
            }
            catch (err) {
                api.logger.error(`memory-qdrant: indexing failed: ${err}`);
            }
            finally {
                indexing = false;
            }
        }
        // ========================================================================
        // Tools
        // ========================================================================
        const MemorySearchSchema = typebox_1.Type.Object({
            query: typebox_1.Type.String(),
            maxResults: typebox_1.Type.Optional(typebox_1.Type.Number()),
            minScore: typebox_1.Type.Optional(typebox_1.Type.Number()),
        });
        const MemoryGetSchema = typebox_1.Type.Object({
            path: typebox_1.Type.String(),
            from: typebox_1.Type.Optional(typebox_1.Type.Number()),
            lines: typebox_1.Type.Optional(typebox_1.Type.Number()),
        });
        const CapturedCategorySchema = typebox_1.Type.Union(CAPTURED_CATEGORIES.map((category) => typebox_1.Type.Literal(category)));
        const MemoryCapturedListSchema = typebox_1.Type.Object({
            category: typebox_1.Type.Optional(CapturedCategorySchema),
            limit: typebox_1.Type.Optional(typebox_1.Type.Number()),
            offset: typebox_1.Type.Optional(typebox_1.Type.String()),
        });
        const MemoryCapturedDeleteSchema = typebox_1.Type.Object({
            id: typebox_1.Type.String(),
        });
        const MemoryCapturedExportSchema = typebox_1.Type.Object({
            category: typebox_1.Type.Optional(CapturedCategorySchema),
            limit: typebox_1.Type.Optional(typebox_1.Type.Number()),
            title: typebox_1.Type.Optional(typebox_1.Type.String()),
        });
        api.registerTool({
            name: "memory_search",
            label: "Memory Search",
            description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
            parameters: MemorySearchSchema,
            execute: async (_toolCallId, params) => {
                const query = (0, plugin_sdk_1.readStringParam)(params, "query", { required: true });
                const maxResults = (0, plugin_sdk_1.readNumberParam)(params, "maxResults") ?? 5;
                const minScore = (0, plugin_sdk_1.readNumberParam)(params, "minScore") ?? 0.5;
                try {
                    const vector = await embeddings.embed(query);
                    const results = await qdrant.search(vector, maxResults, minScore);
                    return (0, plugin_sdk_1.jsonResult)({
                        results: results.map((r) => ({
                            file: r.file,
                            startLine: r.startLine,
                            endLine: r.endLine,
                            snippet: r.snippet,
                            score: r.score,
                            source: r.source,
                        })),
                        provider: "ollama",
                        model: cfg.embeddingModel,
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return (0, plugin_sdk_1.jsonResult)({ results: [], disabled: false, error: message });
                }
            },
        }, { names: ["memory_search"] });
        api.registerTool({
            name: "memory_get",
            label: "Memory Get",
            description: "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
            parameters: MemoryGetSchema,
            execute: async (_toolCallId, params) => {
                const relPath = (0, plugin_sdk_1.readStringParam)(params, "path", { required: true });
                const fromLine = (0, plugin_sdk_1.readNumberParam)(params, "from", { integer: true }) ?? 1;
                const lineCount = (0, plugin_sdk_1.readNumberParam)(params, "lines", { integer: true });
                // Security: only allow reading from indexed sources
                const allowedPrefixes = ["MEMORY.md", "memory/", "vault/", "extra/", "captured/"];
                if (!allowedPrefixes.some((prefix) => relPath.startsWith(prefix))) {
                    return (0, plugin_sdk_1.jsonResult)({
                        path: relPath,
                        text: "",
                        error: "Access denied: path outside indexed sources",
                    });
                }
                // Captured memories are stored in Qdrant, not files
                if (relPath.startsWith("captured/")) {
                    return (0, plugin_sdk_1.jsonResult)({
                        path: relPath,
                        text: "(captured memory - stored in vector DB only)",
                        note: "Use memory_search to find captured memories",
                    });
                }
                try {
                    let fullPath;
                    if (relPath.startsWith("vault/")) {
                        fullPath = (0, node_path_1.join)(resolvedVaultPath, relPath.slice(6));
                    }
                    else if (relPath.startsWith("extra/")) {
                        const parts = relPath.split("/").slice(1);
                        const index = Number(parts.shift());
                        const root = extraRoots.find((entry) => entry.index === index);
                        if (!root) {
                            return (0, plugin_sdk_1.jsonResult)({
                                path: relPath,
                                text: "",
                                error: "Unknown extra path index",
                            });
                        }
                        fullPath = (0, node_path_1.join)(root.resolved, ...parts);
                    }
                    else {
                        fullPath = (0, node_path_1.join)(resolvedWorkspacePath, relPath);
                    }
                    const content = await (0, promises_1.readFile)(fullPath, "utf-8");
                    const lines = content.split("\n");
                    const start = Math.max(0, fromLine - 1);
                    const end = lineCount ? Math.min(lines.length, start + lineCount) : lines.length;
                    const text = lines.slice(start, end).join("\n");
                    return (0, plugin_sdk_1.jsonResult)({
                        path: relPath,
                        from: fromLine,
                        lines: end - start,
                        text,
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return (0, plugin_sdk_1.jsonResult)({ path: relPath, text: "", error: message });
                }
            },
        }, { names: ["memory_get"] });
        api.registerTool({
            name: "memory_captured_list",
            label: "Captured Memory List",
            description: "List captured memories stored in Qdrant.",
            parameters: MemoryCapturedListSchema,
            execute: async (_toolCallId, params) => {
                const category = params.category;
                const limit = (0, plugin_sdk_1.readNumberParam)(params, "limit", { integer: true }) ?? 20;
                const offset = (0, plugin_sdk_1.readStringParam)(params, "offset", { allowEmpty: true });
                try {
                    const { items, nextOffset } = await qdrant.listCaptured(category, limit, offset || undefined);
                    return (0, plugin_sdk_1.jsonResult)({
                        items,
                        nextOffset,
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return (0, plugin_sdk_1.jsonResult)({ items: [], error: message });
                }
            },
        }, { names: ["memory_captured_list"] });
        api.registerTool({
            name: "memory_captured_delete",
            label: "Captured Memory Delete",
            description: "Delete a captured memory by id.",
            parameters: MemoryCapturedDeleteSchema,
            execute: async (_toolCallId, params) => {
                const id = (0, plugin_sdk_1.readStringParam)(params, "id", { required: true });
                try {
                    await qdrant.deleteCaptured(id);
                    return (0, plugin_sdk_1.jsonResult)({ id, deleted: true });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return (0, plugin_sdk_1.jsonResult)({ id, deleted: false, error: message });
                }
            },
        }, { names: ["memory_captured_delete"] });
        api.registerTool({
            name: "memory_captured_export",
            label: "Captured Memory Export",
            description: "Export captured memories to the Obsidian inbox.",
            parameters: MemoryCapturedExportSchema,
            execute: async (_toolCallId, params) => {
                const category = params.category;
                const limit = (0, plugin_sdk_1.readNumberParam)(params, "limit", { integer: true }) ?? 100;
                const title = (0, plugin_sdk_1.readStringParam)(params, "title", { allowEmpty: true })?.trim();
                try {
                    const { items } = await qdrant.listCaptured(category, limit);
                    const inboxDir = (0, node_path_1.join)(resolvedVaultPath, "00 Inbox");
                    await (0, promises_1.mkdir)(inboxDir, { recursive: true });
                    const now = new Date();
                    const timestamp = now.toISOString().replace(/[:.]/g, "-");
                    const filename = `${title?.length ? title : "captured-memories"}-${timestamp}.md`;
                    const fullPath = (0, node_path_1.join)(inboxDir, filename);
                    const header = `# ${title?.length ? title : "Captured memories"}\n\n`;
                    const meta = `- Exported: ${now.toISOString()}\n- Count: ${items.length}\n\n`;
                    const body = items
                        .map((item) => {
                        const date = item.capturedAt
                            ? new Date(item.capturedAt).toISOString()
                            : "";
                        return `- **${item.category}** (${date}) ${item.text}`;
                    })
                        .join("\n");
                    await (0, promises_1.writeFile)(fullPath, `${header}${meta}${body}\n`);
                    return (0, plugin_sdk_1.jsonResult)({ path: `vault/00 Inbox/${filename}`, count: items.length });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return (0, plugin_sdk_1.jsonResult)({ error: message });
                }
            },
        }, { names: ["memory_captured_export"] });
        // ========================================================================
        // Lifecycle Hooks: Auto-Recall & Auto-Capture
        // ========================================================================
        // Auto-recall: inject relevant memories before agent starts
        if (cfg.autoRecall) {
            api.on("before_agent_start", async (event) => {
                // Skip if prompt is too short or already has memories
                if (!event.prompt || event.prompt.length < 10)
                    return;
                if (event.prompt.includes("<relevant-memories>"))
                    return;
                try {
                    const vector = await embeddings.embed(event.prompt);
                    const results = await qdrant.search(vector, cfg.autoRecallLimit, cfg.autoRecallMinScore);
                    if (results.length === 0)
                        return;
                    const memoryContext = results
                        .map((r) => `- [${r.source}/${r.file}] ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`)
                        .join("\n");
                    api.logger.info(`memory-qdrant: auto-recall injecting ${results.length} memories`);
                    return {
                        prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>\n\n`,
                    };
                }
                catch (err) {
                    api.logger.warn(`memory-qdrant: auto-recall failed: ${String(err)}`);
                }
            });
        }
        // Auto-capture: extract and store important information on message_received
        if (cfg.autoCapture) {
            api.logger.info("memory-qdrant: registering message_received hook for auto-capture");
            api.on("message_received", async (event, ctx) => {
                try {
                    const text = event?.content;
                    if (!text || typeof text !== "string")
                        return;
                    // Filter for capturable content
                    if (!shouldCapture(text))
                        return;
                    // Rate limit per conversation/session
                    const key = ctx?.conversationId || ctx?.sessionKey || event?.from || "default";
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
                        api.logger.warn(`memory-qdrant: duplicate check failed (proceeding anyway): ${dup.error}`);
                    }
                    if (dup.exists) {
                        api.logger.info(`memory-qdrant: skipping duplicate (${dup.score.toFixed(2)}): ${text.slice(0, 50)}...`);
                        return;
                    }
                    const category = detectCategory(text);
                    const memory = {
                        id: (0, node_crypto_1.createHash)("sha256").update(`${Date.now()}-${text}`).digest("hex").slice(0, 32),
                        text,
                        category,
                        capturedAt: Date.now(),
                        sessionKey: ctx?.sessionKey,
                    };
                    await qdrant.upsertCaptured(memory, vector);
                    api.logger.info(`memory-qdrant: auto-captured [${category}]: ${text.slice(0, 50)}...`);
                }
                catch (err) {
                    api.logger.warn(`memory-qdrant: auto-capture failed: ${String(err)}`);
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
                if (cfg.autoRecall)
                    features.push("auto-recall");
                if (cfg.autoCapture)
                    features.push("auto-capture");
                api.logger.info(`memory-qdrant: initialized (vault: ${resolvedVaultPath}, collection: ${cfg.collection}, features: [${features.join(", ") || "none"}])`);
                if (cfg.autoIndex) {
                    try {
                        await (0, promises_1.stat)(resolvedVaultPath);
                    }
                    catch (err) {
                        api.logger.error(`memory-qdrant: vaultPath missing or inaccessible: ${resolvedVaultPath}`);
                        return;
                    }
                    // Initial indexing
                    indexingPromise = runIndexing();
                    // Watch for changes
                    const watchPaths = [
                        resolvedVaultPath,
                        (0, node_path_1.join)(resolvedWorkspacePath, "MEMORY.md"),
                        (0, node_path_1.join)(resolvedWorkspacePath, "memory"),
                        ...extraRoots.map((entry) => entry.resolved),
                    ];
                    fileWatcher = (0, chokidar_1.watch)(watchPaths, {
                        ignored: /(^|[\/\\])\../, // Ignore dotfiles
                        persistent: true,
                        ignoreInitial: true,
                    });
                    fileWatcher.on("add", scheduleIndex);
                    fileWatcher.on("change", scheduleIndex);
                    fileWatcher.on("unlink", scheduleIndex);
                    api.logger.info(`memory-qdrant: watching ${watchPaths.length} paths for changes`);
                }
            },
            stop: async () => {
                if (fileWatcher) {
                    await fileWatcher.close();
                    fileWatcher = null;
                }
                if (indexingPromise) {
                    await indexingPromise;
                }
                api.logger.info("memory-qdrant: stopped");
            },
        });
    },
};
exports.default = memoryQdrantPlugin;
