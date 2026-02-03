import { Type } from "@sinclair/typebox";
import { watch } from "chokidar";
import MiniSearch from "minisearch";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
const CAPTURED_CATEGORIES = ["preference", "project", "personal", "other"];
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
  autoCaptureWindowMs: 5 * 60 * 1e3,
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
  /\+\d{10,}/,
  // Phone numbers
  /[\w.-]+@[\w.-]+\.\w{2,}/,
  // Emails
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
const MEMORY_EXCLUSIONS = [
  // System/tool output
  /<[^>]+>/,
  // XML tags
  /```[\s\S]*?```/,
  // Code blocks (non-greedy to handle multiple blocks)
  /^\s*[-*]\s+/m,
  // Markdown lists (likely tool output)
  // Agent confirmations
  /\b(pronto|feito|ok|certo|entendi|anotado)\b.*!?\s*$/i,
  /\b(done|got it|noted|understood|saved)\b.*!?\s*$/i,
  // Questions (don't capture questions, capture answers)
  /\?\s*$/,
  // Very short or very long
  /^.{0,14}$/,
  // Less than 15 chars
  /^.{501,}$/,
  // More than 500 chars
];
function shouldCapture(text) {
  for (const pattern of MEMORY_EXCLUSIONS) {
    if (pattern.test(text)) return false;
  }
  if (text.includes("<relevant-memories>")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  for (const pattern of MEMORY_TRIGGERS) {
    if (pattern.test(text)) return true;
  }
  return false;
}
function detectCategory(text) {
  const lower = text.toLowerCase();
  if (/prefer|prefiro|gosto|like|love|hate|want|quero|odeio|adoro/i.test(lower)) {
    return "preference";
  }
  if (
    /decidimos|decided|will use|vamos usar|escolhi|chose|projeto|project|feature|roadmap|meta|objetivo/i.test(
      lower,
    )
  ) {
    return "project";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|nome é|name is|chamo|called|moro|sou|trabalho/i.test(lower)) {
    return "personal";
  }
  return "other";
}
class KnowledgeGraph {
  nodes = /* @__PURE__ */ new Map();
  graphPath;
  dirty = false;
  constructor(workspacePath) {
    this.graphPath = join(workspacePath, ".memory-graph.json");
  }
  async load() {
    try {
      const data = await readFile(this.graphPath, "utf-8");
      const raw = JSON.parse(data);
      this.nodes = new Map(Object.entries(raw));
    } catch {}
  }
  async save() {
    if (!this.dirty) return;
    const obj = Object.fromEntries(this.nodes);
    await writeFile(this.graphPath, JSON.stringify(obj, null, 2));
    this.dirty = false;
  }
  extractLinks(text) {
    const regex = /\[\[(.*?)\]\]/g;
    const links = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const link = match[1].split("|")[0].trim();
      if (link) links.push(link);
    }
    return links;
  }
  updateFile(file, text) {
    const links = this.extractLinks(text);
    const existing = this.nodes.get(file);
    const oldLinks = existing ? existing.links : [];
    this.nodes.set(file, {
      file,
      links,
      backlinks: existing ? existing.backlinks : [],
    });
    for (const oldLink of oldLinks) {
      if (!links.includes(oldLink)) {
        this.removeBacklink(oldLink, file);
      }
    }
    for (const link of links) {
      if (!oldLinks.includes(link)) {
        this.addBacklink(link, file);
      }
    }
    this.dirty = true;
  }
  addBacklink(target, source) {
    const node = this.nodes.get(target) || { file: target, links: [], backlinks: [] };
    if (!node.backlinks.includes(source)) {
      node.backlinks.push(source);
      this.nodes.set(target, node);
    }
  }
  removeBacklink(target, source) {
    const node = this.nodes.get(target);
    if (node) {
      node.backlinks = node.backlinks.filter((b) => b !== source);
      this.nodes.set(target, node);
    }
  }
  removeFile(file) {
    const node = this.nodes.get(file);
    if (!node) return;
    for (const link of node.links) {
      this.removeBacklink(link, file);
    }
    if (node.backlinks.length === 0) {
      this.nodes.delete(file);
    } else {
      node.links = [];
      this.nodes.set(file, node);
    }
    this.dirty = true;
  }
  getRelated(file) {
    let node = this.nodes.get(file);
    if (!node && file.endsWith(".md")) {
      node = this.nodes.get(file.slice(0, -3));
    }
    if (!node) {
      const basename = file.split("/").pop()?.replace(".md", "");
      if (basename) {
        for (const [key, value] of this.nodes) {
          if (key === basename || key.endsWith("/" + basename)) {
            node = value;
            break;
          }
        }
      }
    }
    if (!node) return { links: [], backlinks: [] };
    return { links: node.links, backlinks: node.backlinks };
  }
  getOrphans() {
    const orphans = [];
    for (const [file, node] of this.nodes) {
      if (node.backlinks.length === 0) {
        orphans.push(file);
      }
    }
    return orphans;
  }
}
class TextIndex {
  index;
  indexPath;
  dirty = false;
  constructor(workspacePath) {
    this.indexPath = join(workspacePath, ".memory-index.json");
    this.index = new MiniSearch({
      fields: ["text", "file"],
      // Fields to index
      storeFields: ["id", "file", "startLine", "endLine", "text", "source"],
      // Fields to return
      searchOptions: {
        boost: { text: 2 },
        fuzzy: 0.2,
      },
    });
  }
  async load() {
    try {
      const data = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(data);
      const indexData = parsed.documentCount !== void 0 ? parsed : parsed.index;
      if (indexData) {
        this.index = MiniSearch.loadJSON(indexData, {
          fields: ["text", "file"],
          storeFields: ["id", "file", "startLine", "endLine", "text", "source"],
        });
      }
    } catch (err) {}
  }
  async save() {
    if (!this.dirty) return;
    await writeFile(this.indexPath, JSON.stringify(this.index.toJSON()));
    this.dirty = false;
  }
  add(chunks) {
    if (chunks.length === 0) return;
    const docs = chunks.map((c) => ({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      source: c.file.startsWith("captured/")
        ? "captured"
        : c.file.startsWith("vault/")
          ? "vault"
          : "workspace",
    }));
    this.index.addAll(docs);
    this.dirty = true;
  }
  removeByFile(file) {
    const json = this.index.toJSON();
    const allDocs = Object.values(json.documents || {});
    const docsToKeep = allDocs.filter((doc) => doc.file !== file);
    if (docsToKeep.length < allDocs.length) {
      const newIndex = new MiniSearch({
        fields: ["text", "file"],
        storeFields: ["id", "file", "startLine", "endLine", "text", "source"],
        searchOptions: {
          boost: { text: 2 },
          fuzzy: 0.2,
        },
      });
      newIndex.addAll(docsToKeep);
      this.index = newIndex;
      this.dirty = true;
    }
  }
  search(query, limit) {
    return this.index.search(query, { limit });
  }
}
class QdrantClient {
  constructor(url, collection) {
    this.url = url;
    this.collection = collection;
  }
  async ensureCollection(vectorSize) {
    const collections = await this.fetch("/collections");
    const exists = collections.result.collections.some((c) => c.name === this.collection);
    if (exists) return;
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
    if (chunks.length === 0) return;
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
        hash: createHash("sha256").update(memory.text).digest("hex"),
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
      id: String(hit.id),
      file: hit.payload.file,
      startLine: hit.payload.startLine,
      endLine: hit.payload.endLine,
      snippet: truncateSnippet(hit.payload.text),
      score: hit.score,
      source:
        hit.payload.source === "captured"
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
    } catch (err) {
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
class OllamaEmbeddings {
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
    const data = await response.json();
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
function chunkText(text, targetWords = 400, overlapWords = 80) {
  const MAX_LINE_CHARS = 2e3;
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
        const text2 = currentChunk.join("\n");
        if (text2.trim().length > 0) {
          chunks.push({
            id: "",
            // Will be set during indexing
            file: "",
            // Will be set during indexing
            startLine: chunkStartLine,
            endLine: chunkStartLine + currentChunk.length - 1,
            text: text2,
            hash: "",
          });
        }
      }
      if (i < lines.length - 1 && overlapWords > 0) {
        let overlapCount = 0;
        const overlapLines = [];
        for (let j = currentChunk.length - 1; j >= 0; j--) {
          const words = currentChunk[j].split(/\s+/).filter(Boolean).length;
          overlapCount += words;
          overlapLines.unshift(currentChunk[j]);
          if (overlapCount >= overlapWords) break;
        }
        chunkStartLine = chunkStartLine + currentChunk.length - overlapLines.length;
        currentChunk = overlapLines;
        currentWordCount = overlapCount;
      } else {
        chunkStartLine = chunkStartLine + currentChunk.length;
        currentChunk = [];
        currentWordCount = 0;
      }
    }
  }
  return chunks;
}
async function indexFile(filePath, relPath, qdrant, embeddings, textIndex, knowledgeGraph) {
  const content = await readFile(filePath, "utf-8");
  const chunks = chunkText(content);
  if (chunks.length === 0) return 0;
  const processedChunks = chunks.map((chunk) => {
    const id = createHash("sha256")
      .update(`${relPath}:${chunk.startLine}-${chunk.endLine}`)
      .digest("hex")
      .slice(0, 32);
    const hash = createHash("sha256").update(chunk.text).digest("hex");
    return { ...chunk, id, file: relPath, hash };
  });
  await qdrant.deleteByFile(relPath);
  if (textIndex) {
    textIndex.removeByFile(relPath);
    textIndex.add(processedChunks);
  }
  if (knowledgeGraph) {
    knowledgeGraph.updateFile(relPath, content);
  }
  const vectors = await embeddings.embedBatch(processedChunks.map((c) => c.text));
  await qdrant.upsert(processedChunks, vectors);
  return processedChunks.length;
}
async function findMarkdownFiles(dir) {
  const files = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findMarkdownFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch (err) {}
  return files;
}
async function indexDirectory(dir, prefix, qdrant, embeddings, logger, textIndex, knowledgeGraph) {
  const files = await findMarkdownFiles(dir);
  let totalChunks = 0;
  for (const file of files) {
    const relPath = `${prefix}${relative(dir, file)}`;
    try {
      const chunks = await indexFile(file, relPath, qdrant, embeddings, textIndex, knowledgeGraph);
      totalChunks += chunks;
    } catch (err) {
      logger.info(`memory-qdrant: failed to index ${relPath}: ${err}`);
    }
  }
  return totalChunks;
}
function truncateSnippet(text, maxChars = 700) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}
const memoryQdrantPlugin = {
  id: "memory-qdrant",
  name: "Memory (Qdrant + Ollama)",
  description:
    "Local memory search with Qdrant vector DB, Ollama embeddings, Obsidian vault support, auto-recall and auto-capture",
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
    const textIndex = new TextIndex(resolvedWorkspacePath);
    const knowledgeGraph = new KnowledgeGraph(resolvedWorkspacePath);
    let indexing = false;
    let indexingPromise = null;
    let fileWatcher = null;
    const captureWindow = /* @__PURE__ */ new Map();
    const scheduleIndex = /* @__PURE__ */ (() => {
      let timeout = null;
      return () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => runIndexing(), 1500);
      };
    })();
    async function runIndexing() {
      if (indexing) return;
      indexing = true;
      try {
        api.logger.info("memory-qdrant: indexing started");
        const dims = await embeddings.getDimensions();
        await qdrant.ensureCollection(dims);
        let totalChunks = 0;
        totalChunks += await indexDirectory(
          resolvedVaultPath,
          "vault/",
          qdrant,
          embeddings,
          api.logger,
          textIndex,
          knowledgeGraph,
        );
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
        } catch {}
        const memoryDir = join(resolvedWorkspacePath, "memory");
        totalChunks += await indexDirectory(
          memoryDir,
          "memory/",
          qdrant,
          embeddings,
          api.logger,
          textIndex,
          knowledgeGraph,
        );
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
                api.logger,
                textIndex,
                knowledgeGraph,
              );
            }
          } catch {}
        }
        await textIndex.save();
        await knowledgeGraph.save();
        api.logger.info(`memory-qdrant: indexed ${totalChunks} chunks`);
      } catch (err) {
        api.logger.error(`memory-qdrant: indexing failed: ${err}`);
      } finally {
        indexing = false;
      }
    }
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
            const vector = await embeddings.embed(query);
            const vectorResults = await qdrant.search(vector, maxResults, minScore);
            const textHits = textIndex.search(query, Math.max(maxResults * 4, 10));
            const maxTextScore =
              textHits.reduce((max, hit) => Math.max(max, hit.score || 0), 0) || 1;
            const textResults = textHits.map((hit) => ({
              id: String(hit.id),
              file: hit.file,
              startLine: hit.startLine ?? 1,
              endLine: hit.endLine ?? 1,
              snippet: truncateSnippet(hit.text || ""),
              score: (hit.score || 0) / maxTextScore,
              source:
                hit.source ||
                (hit.file?.startsWith("vault/")
                  ? "vault"
                  : hit.file?.startsWith("captured/")
                    ? "captured"
                    : "workspace"),
            }));
            const vectorWeight = 0.7;
            const textWeight = 0.3;
            const merged = /* @__PURE__ */ new Map();
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
                const related = knowledgeGraph.getRelated(res.file);
                const relatedFiles = [...related.links, ...related.backlinks].slice(0, 3);
                return {
                  ...res,
                  score: (vectorScore ?? 0) * vectorWeight + (textScore ?? 0) * textWeight,
                  related: relatedFiles.length > 0 ? relatedFiles : void 0,
                };
              })
              .sort((a, b) => b.score - a.score)
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
              hybrid: true,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
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
          const allowedPrefixes = ["MEMORY.md", "memory/", "vault/", "extra/", "captured/"];
          if (!allowedPrefixes.some((prefix) => relPath.startsWith(prefix))) {
            return jsonResult({
              path: relPath,
              text: "",
              error: "Access denied: path outside indexed sources",
            });
          }
          if (relPath.startsWith("captured/")) {
            return jsonResult({
              path: relPath,
              text: "(captured memory - stored in vector DB only)",
              note: "Use memory_search to find captured memories",
            });
          }
          try {
            let fullPath;
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
          const category = params.category;
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
          const offset = readStringParam(params, "offset", { allowEmpty: true });
          try {
            const { items, nextOffset } = await qdrant.listCaptured(
              category,
              limit,
              offset || void 0,
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
          const category = params.category;
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 100;
          const title = readStringParam(params, "title", { allowEmpty: true })?.trim();
          try {
            const { items } = await qdrant.listCaptured(category, limit);
            const inboxDir = join(resolvedVaultPath, "00 Inbox");
            await mkdir(inboxDir, { recursive: true });
            const now = /* @__PURE__ */ new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, "-");
            const filename = `${title?.length ? title : "captured-memories"}-${timestamp}.md`;
            const fullPath = join(inboxDir, filename);
            const header = `# ${title?.length ? title : "Captured memories"}

`;
            const meta = `- Exported: ${now.toISOString()}
- Count: ${items.length}

`;
            const body = items
              .map((item) => {
                const date = item.capturedAt ? new Date(item.capturedAt).toISOString() : "";
                return `- **${item.category}** (${date}) ${item.text}`;
              })
              .join("\n");
            await writeFile(
              fullPath,
              `${header}${meta}${body}
`,
            );
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
          const dryRun = params.dryRun !== false;
          try {
            const orphans = knowledgeGraph.getOrphans();
            const meaningfulOrphans = orphans.filter(
              (f) =>
                !f.includes("01 Journal/") && !f.includes("memory/") && !f.includes("captured/"),
            );
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
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 10) return;
        if (event.prompt.includes("<relevant-memories>")) return;
        try {
          const vector = await embeddings.embed(event.prompt);
          const results = await qdrant.search(vector, cfg.autoRecallLimit, cfg.autoRecallMinScore);
          if (results.length === 0) return;
          const memoryContext = results
            .map(
              (r) =>
                `- [${r.source}/${r.file}] ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`,
            )
            .join("\n");
          api.logger.info(`memory-qdrant: auto-recall injecting ${results.length} memories`);
          return {
            prependContext: `<relevant-memories>
The following memories may be relevant:
${memoryContext}
</relevant-memories>

`,
          };
        } catch (err) {
          api.logger.warn(`memory-qdrant: auto-recall failed: ${String(err)}`);
        }
      });
    }
    if (cfg.autoCapture) {
      api.logger.info("memory-qdrant: registering message_received hook for auto-capture");
      api.on("message_received", async (event, ctx) => {
        try {
          const text = event?.content;
          if (!text || typeof text !== "string") return;
          if (!shouldCapture(text)) return;
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
          const dup = await qdrant.searchForDuplicates(vector, cfg.autoCaptureDupThreshold);
          if (dup.error) {
            api.logger.warn(
              `memory-qdrant: duplicate check failed (proceeding anyway): ${dup.error}`,
            );
          }
          if (dup.exists) {
            api.logger.info(
              `memory-qdrant: skipping duplicate (${dup.score.toFixed(2)}): ${text.slice(0, 50)}...`,
            );
            return;
          }
          const category = detectCategory(text);
          const memory = {
            id: createHash("sha256").update(`${Date.now()}-${text}`).digest("hex").slice(0, 32),
            text,
            category,
            capturedAt: Date.now(),
            sessionKey: ctx?.sessionKey,
          };
          await qdrant.upsertCaptured(memory, vector);
          api.logger.info(`memory-qdrant: auto-captured [${category}]: ${text.slice(0, 50)}...`);
        } catch (err) {
          api.logger.warn(`memory-qdrant: auto-capture failed: ${String(err)}`);
        }
      });
    }
    api.registerService({
      id: "memory-qdrant-indexer",
      start: async () => {
        const features = [];
        if (cfg.autoRecall) features.push("auto-recall");
        if (cfg.autoCapture) features.push("auto-capture");
        api.logger.info(
          `memory-qdrant: initialized (vault: ${resolvedVaultPath}, collection: ${cfg.collection}, features: [${features.join(", ") || "none"}])`,
        );
        await textIndex.load();
        await knowledgeGraph.load();
        if (cfg.autoIndex) {
          try {
            await stat(resolvedVaultPath);
          } catch (err) {
            api.logger.error(
              `memory-qdrant: vaultPath missing or inaccessible: ${resolvedVaultPath}`,
            );
            return;
          }
          indexingPromise = runIndexing();
          const watchPaths = [
            resolvedVaultPath,
            join(resolvedWorkspacePath, "MEMORY.md"),
            join(resolvedWorkspacePath, "memory"),
            ...extraRoots.map((entry) => entry.resolved),
          ];
          fileWatcher = watch(watchPaths, {
            ignored: /(^|[\/\\])\../,
            // Ignore dotfiles
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
        await textIndex.save();
        await knowledgeGraph.save();
        api.logger.info("memory-qdrant: stopped");
      },
    });
  },
};
var index_default = memoryQdrantPlugin;
export {
  KnowledgeGraph,
  OllamaEmbeddings,
  QdrantClient,
  TextIndex,
  chunkText,
  index_default as default,
  detectCategory,
  findMarkdownFiles,
  indexDirectory,
  indexFile,
  parseConfig,
  shouldCapture,
  truncateSnippet,
};
