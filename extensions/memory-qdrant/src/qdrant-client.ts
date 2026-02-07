import { createHash } from "node:crypto";
import type { KnowledgeGraph } from "./knowledge-graph.ts";
import type { CapturedCategory, CapturedMemory, MemoryChunk, MemorySearchResult } from "./types.ts";
import { parseYamlFrontmatter, inferCategory, extractHeaders } from "./metadata.ts";
import { CAPTURED_CATEGORIES } from "./types.ts";
import { truncateSnippet } from "./utils.ts";

// ============================================================================
// Qdrant Client
// ============================================================================

export class QdrantClient {
  constructor(
    private readonly url: string,
    private readonly collection: string,
  ) {}

  async ensureCollection(vectorSize: number): Promise<void> {
    const { result } = await this.fetch<{ result: { exists: boolean } }>(
      `/collections/${this.collection}/exists`,
    );

    if (!result.exists) {
      await this.fetch(`/collections/${this.collection}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
          // Scalar quantization: ~4x memory reduction with <1% accuracy loss
          quantization_config: {
            scalar: {
              type: "int8",
              quantile: 0.99,
              always_ram: true,
            },
          },
        }),
      });
    }

    // Ensure payload indexes exist (idempotent — Qdrant ignores if already present).
    // Called on every startup so that new indexes are applied to existing collections.
    await this.ensurePayloadIndexes();
  }

  /**
   * Create keyword payload indexes for fields used in filtering.
   * Also creates a principal integer index for capturedAt (time-based queries).
   * Idempotent: Qdrant ignores if index already exists.
   */
  async ensurePayloadIndexes(): Promise<void> {
    const keywordFields = ["file", "category", "source"];
    for (const field of keywordFields) {
      await this.fetch(`/collections/${this.collection}/index`, {
        method: "PUT",
        body: JSON.stringify({
          field_name: field,
          field_schema: "keyword",
        }),
      });
    }

    // Add principal index for capturedAt (timestamp-based queries)
    // is_principal optimizes storage for queries filtered by this field
    await this.fetch(`/collections/${this.collection}/index`, {
      method: "PUT",
      body: JSON.stringify({
        field_name: "capturedAt",
        field_schema: {
          type: "integer",
          range: true,
          lookup: false,
          is_principal: true,
        },
      }),
    });
  }

  /**
   * Health check: verify Qdrant is reachable.
   */
  async healthCheck(): Promise<void> {
    await this.fetch("/");
  }

  async deleteByFile(file: string): Promise<void> {
    await this.fetch(`/collections/${this.collection}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [{ key: "file", match: { value: file } }],
        },
      }),
    });
  }

  /**
   * Batch upsert: atomically delete old points and insert new ones for a file.
   * Uses Qdrant's batch API for atomic operations (avoids race conditions).
   */
  async batchUpsertFile(
    file: string,
    chunks: MemoryChunk[],
    embeddings: number[][],
    kg?: KnowledgeGraph,
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const points = chunks.map((chunk, i) => {
      const { tags: frontmatterTags, metadata: frontmatterMeta } = parseYamlFrontmatter(chunk.text);
      const headers = extractHeaders(chunk.text);
      const category = inferCategory(chunk.file);
      const links = kg ? kg.getLinks(chunk.file) || [] : [];

      return {
        id: Number(chunk.id),
        vector: embeddings[i],
        payload: {
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          hash: chunk.hash,
          tags: [...new Set([...frontmatterTags, ...headers])],
          links: links,
          category: category,
          metadata: frontmatterMeta,
        },
      };
    });

    // Batch API: atomic delete + upsert (avoids race conditions)
    await this.fetch(`/collections/${this.collection}/points/batch?wait=true`, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          {
            delete: {
              filter: {
                must: [{ key: "file", match: { value: file } }],
              },
            },
          },
          {
            upsert: { points },
          },
        ],
      }),
    });
  }

  async upsert(chunks: MemoryChunk[], embeddings: number[][], kg?: KnowledgeGraph): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const points = chunks.map((chunk, i) => {
      const { tags: frontmatterTags, metadata: frontmatterMeta } = parseYamlFrontmatter(chunk.text);
      const headers = extractHeaders(chunk.text);
      const category = inferCategory(chunk.file);
      const links = kg ? kg.getLinks(chunk.file) || [] : [];

      return {
        id: Number(chunk.id),
        vector: embeddings[i],
        payload: {
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          hash: chunk.hash,
          tags: [...new Set([...frontmatterTags, ...headers])], // Deduplicate
          links: links,
          category: category,
          metadata: frontmatterMeta,
        },
      };
    });

    await this.fetch(`/collections/${this.collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points }),
    });
  }

  async upsertCaptured(memory: CapturedMemory, embedding: number[]): Promise<void> {
    const point = {
      id: Number(memory.id),
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

    await this.fetch(`/collections/${this.collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: [point] }),
    });
  }

  async listCaptured(
    category?: CapturedCategory,
    limit = 20,
    offset?: string,
  ): Promise<{ items: CapturedMemory[]; nextOffset?: string }> {
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

    const response = await this.fetch<{
      result: {
        points: Array<{
          id: string;
          payload?: {
            text?: string;
            category?: CapturedCategory;
            capturedAt?: number;
            sessionKey?: string;
          };
        }>;
        next_page_offset?: string;
      };
    }>(`/collections/${this.collection}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({
        limit,
        offset,
        filter,
        with_payload: ["text", "category", "capturedAt", "sessionKey"],
        with_vector: false,
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

  async deleteCaptured(id: string): Promise<void> {
    await this.fetch(`/collections/${this.collection}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: [Number(id)] }),
    });
  }

  async search(
    vector: number[],
    limit: number,
    scoreThreshold: number,
  ): Promise<MemorySearchResult[]> {
    const response = await this.fetch<{
      result: Array<{
        id: string;
        score: number;
        payload: {
          file: string;
          startLine: number;
          endLine: number;
          text: string;
          source?: string;
          capturedAt?: number;
        };
      }>;
    }>(`/collections/${this.collection}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit,
        score_threshold: scoreThreshold,
        with_payload: ["file", "startLine", "endLine", "text", "source", "capturedAt"],
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
      capturedAt: hit.payload.capturedAt,
    }));
  }

  async searchForDuplicates(
    vector: number[],
    threshold: number,
  ): Promise<{ exists: boolean; score: number; text?: string; error?: string }> {
    try {
      const response = await this.fetch<{
        result: Array<{
          score: number;
          payload: { text: string };
        }>;
      }>(`/collections/${this.collection}/points/search`, {
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
      // Return error for caller to log if needed (allows capture to proceed)
      return { exists: false, score: 0, error: String(err) };
    }
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.url}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      throw new Error(`Qdrant ${init?.method || "GET"} ${path}: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
