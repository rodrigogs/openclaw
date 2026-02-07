/**
 * OpenClaw Memory (Qdrant + Ollama) Plugin
 *
 * Barrel re-export — all public API is defined in src/ modules.
 */

export { default } from "./src/plugin.ts";

// Re-export everything tests and consumers need
export { generatePointId, truncateSnippet } from "./src/utils.ts";
export { parseConfig } from "./src/config.ts";
export { shouldCapture, detectCategory } from "./src/auto-capture.ts";
export { parseYamlFrontmatter, inferCategory, extractHeaders } from "./src/metadata.ts";
export { KnowledgeGraph } from "./src/knowledge-graph.ts";
export { TextIndex } from "./src/text-index.ts";
export { QdrantClient } from "./src/qdrant-client.ts";
export { OllamaEmbeddings } from "./src/ollama-embeddings.ts";
export { chunkText, indexFile, indexDirectory, findMarkdownFiles } from "./src/indexing.ts";
