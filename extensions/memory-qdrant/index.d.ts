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
type MemoryChunk = {
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
};
type MemorySearchResult = {
    file: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    source: "vault" | "workspace" | "captured";
};
declare const CAPTURED_CATEGORIES: readonly ["preference", "project", "personal", "other"];
type CapturedCategory = (typeof CAPTURED_CATEGORIES)[number];
type CapturedMemory = {
    id: string;
    text: string;
    category: CapturedCategory;
    capturedAt: number;
    sessionKey?: string;
};
type PluginConfig = {
    vaultPath: string;
    workspacePath?: string;
    qdrantUrl?: string;
    collection?: string;
    ollamaUrl?: string;
    embeddingModel?: string;
    autoIndex?: boolean;
    extraPaths?: string[];
    autoRecall?: boolean;
    autoRecallLimit?: number;
    autoRecallMinScore?: number;
    autoCapture?: boolean;
    autoCaptureMax?: number;
    autoCaptureDupThreshold?: number;
};
export declare function parseConfig(raw: unknown, workspaceDir: string): Required<PluginConfig>;
/**
 * Check if text should be captured as a memory.
 */
export declare function shouldCapture(text: string): boolean;
/**
 * Detect memory category based on content.
 */
export declare function detectCategory(text: string): CapturedCategory;
export declare class QdrantClient {
    private readonly url;
    private readonly collection;
    constructor(url: string, collection: string);
    ensureCollection(vectorSize: number): Promise<void>;
    deleteByFile(file: string): Promise<void>;
    upsert(chunks: MemoryChunk[], embeddings: number[][]): Promise<void>;
    upsertCaptured(memory: CapturedMemory, embedding: number[]): Promise<void>;
    listCaptured(category?: CapturedCategory, limit?: number, offset?: string): Promise<{
        items: CapturedMemory[];
        nextOffset?: string;
    }>;
    deleteCaptured(id: string): Promise<void>;
    search(vector: number[], limit: number, scoreThreshold: number): Promise<MemorySearchResult[]>;
    searchForDuplicates(vector: number[], threshold: number): Promise<{
        exists: boolean;
        score: number;
        text?: string;
        error?: string;
    }>;
    private fetch;
}
export declare class OllamaEmbeddings {
    private readonly url;
    private readonly model;
    constructor(url: string, model: string);
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    getDimensions(): Promise<number>;
}
export declare function chunkText(text: string, targetWords?: number, overlapWords?: number): MemoryChunk[];
export declare function indexFile(filePath: string, relPath: string, qdrant: QdrantClient, embeddings: OllamaEmbeddings): Promise<number>;
export declare function findMarkdownFiles(dir: string): Promise<string[]>;
export declare function indexDirectory(dir: string, prefix: string, qdrant: QdrantClient, embeddings: OllamaEmbeddings, logger: {
    info: (msg: string) => void;
}): Promise<number>;
export declare function truncateSnippet(text: string, maxChars?: number): string;
declare const memoryQdrantPlugin: {
    id: string;
    name: string;
    description: string;
    kind: "memory";
    configSchema: {
        type: string;
        additionalProperties: boolean;
        properties: {
            vaultPath: {
                type: string;
            };
            workspacePath: {
                type: string;
            };
            qdrantUrl: {
                type: string;
            };
            collection: {
                type: string;
            };
            ollamaUrl: {
                type: string;
            };
            embeddingModel: {
                type: string;
            };
            autoIndex: {
                type: string;
            };
            extraPaths: {
                type: string;
                items: {
                    type: string;
                };
            };
            autoRecall: {
                type: string;
            };
            autoRecallLimit: {
                type: string;
            };
            autoRecallMinScore: {
                type: string;
            };
            autoCapture: {
                type: string;
            };
            autoCaptureMax: {
                type: string;
            };
            autoCaptureDupThreshold: {
                type: string;
            };
        };
        required: string[];
    };
    register(api: OpenClawPluginApi): void;
};
export default memoryQdrantPlugin;
