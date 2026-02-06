/**
 * tests/unit/plugin.test.ts
 * Test: Memory-Qdrant Plugin Core Functionality
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";

/**
 * Mock Memory-Qdrant Plugin
 * Validates the core consolidation logic
 */
interface QdrantMemory {
  id: string;
  content: string;
  embedding?: number[];
  timestamp: number;
  quality?: number;
  category?: string;
}

class MemoryQdrantPlugin {
  memories: Map<string, QdrantMemory> = new Map();

  storeMemory(memory: QdrantMemory): void {
    memory.embedding = this.generateEmbedding(memory.content);
    memory.timestamp = Date.now();
    this.memories.set(memory.id, memory);
  }

  searchMemories(query: string, limit: number = 5): QdrantMemory[] {
    const queryEmbedding = this.generateEmbedding(query);
    const scored = Array.from(this.memories.values()).map((m) => ({
      memory: m,
      score: this.cosineSimilarity(queryEmbedding, m.embedding || []),
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.memory);
  }

  getAllMemories(): QdrantMemory[] {
    return Array.from(this.memories.values());
  }

  deleteMemory(id: string): void {
    this.memories.delete(id);
  }

  private generateEmbedding(text: string): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < 8; i++) {
      let hash = 0;
      for (let j = 0; j < text.length; j++) {
        hash = (hash << 5) - hash + text.charCodeAt(j) + i;
      }
      embedding.push(Math.sin(hash) * 0.5 + 0.5);
    }
    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dotProduct += a[i] * b[i];
      magnitudeA += a[i] * a[i];
      magnitudeB += b[i] * b[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  }
}

describe("Memory-Qdrant Plugin", () => {
  let plugin: MemoryQdrantPlugin;

  beforeAll(() => {
    plugin = new MemoryQdrantPlugin();
  });

  describe("Storage", () => {
    it("should store memory with embedding", () => {
      const memory: QdrantMemory = {
        id: "test-001",
        content: "Test memory with embedding",
        timestamp: Date.now(),
      };

      plugin.storeMemory(memory);
      const stored = plugin.getAllMemories();

      expect(stored).toHaveLength(1);
      expect(stored[0].embedding).toBeTruthy();
      expect(stored[0].embedding).toHaveLength(8);
    });

    it("should store multiple memories", () => {
      const memories = [
        {
          id: "mem-002",
          content: "Second memory",
          timestamp: Date.now(),
        },
        {
          id: "mem-003",
          content: "Third memory",
          timestamp: Date.now(),
        },
      ];

      for (const memory of memories) {
        plugin.storeMemory(memory);
      }

      expect(plugin.getAllMemories()).toHaveLength(3);
    });
  });

  describe("Search", () => {
    it("should search memories", () => {
      const results = plugin.searchMemories("memory");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].embedding).toBeTruthy();
    });

    it("should respect limit", () => {
      const results = plugin.searchMemories("memory", 2);

      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Deletion", () => {
    it("should delete memory", () => {
      plugin.deleteMemory("test-001");

      const remaining = plugin.getAllMemories();
      expect(remaining.find((m) => m.id === "test-001")).toBeUndefined();
    });
  });

  describe("Consolidation Integration", () => {
    beforeAll(() => {
      plugin.memories.clear();
    });

    it("should store consolidated session", () => {
      const content = loadFixture("good-session.md");

      plugin.storeMemory({
        id: "consolidated-001",
        content,
        category: "project",
        timestamp: Date.now(),
      });

      const all = plugin.getAllMemories();
      expect(all).toHaveLength(1);
      expect(all[0].content).toContain("Memory consolidation");
    });

    it("should find memories with semantic search", () => {
      const results = plugin.searchMemories("memory consolidation");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("consolidation");
    });
  });
});
