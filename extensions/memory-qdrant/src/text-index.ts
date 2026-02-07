import MiniSearch from "minisearch";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryChunk } from "./types.ts";

// ============================================================================
// Text Search (MiniSearch)
// ============================================================================

export class TextIndex {
  private index: MiniSearch;
  private indexPath: string;
  private dirty = false;

  constructor(workspacePath: string) {
    this.indexPath = join(workspacePath, ".memory-qdrant", "index.json");
    this.index = new MiniSearch({
      fields: ["text", "file"], // Fields to index
      storeFields: ["id", "file", "startLine", "endLine", "text", "source"], // Fields to return
      searchOptions: {
        boost: { text: 2 },
        fuzzy: 0.2,
      },
    });
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(data);

      // Handle the case where we stored both the index and the documents
      const indexData = parsed.index !== undefined ? parsed.index : parsed;

      if (indexData && typeof indexData === "object" && indexData.documentCount !== undefined) {
        this.index = MiniSearch.loadJSON(JSON.stringify(indexData), {
          fields: ["text", "file"],
          storeFields: ["id", "file", "startLine", "endLine", "text", "source"],
        });

        // If we have documents, we don't need to do anything else for search,
        // but we'll use them for removeByFile if they were provided.
        // We'll store them in an internal map.
      }
    } catch {
      // Index doesn't exist yet; ensure directory exists
      await mkdir(join(this.indexPath, ".."), { recursive: true });
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    // MiniSearch toJSON returns the index object.
    // We'll wrap it to potentially include more metadata in the future.
    const data = {
      index: this.index.toJSON(),
      // We don't strictly need to store documents if we only use them for removeByFile
      // during the same session, but for full robustness we could.
      // However, to keep the file small and since it's a cache, we'll just save the index.
    };

    await mkdir(join(this.indexPath, ".."), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(data));
    this.dirty = false;
  }

  add(chunks: MemoryChunk[]): void {
    if (chunks.length === 0) {
      return;
    }

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

  removeByFile(file: string): void {
    // MiniSearch doesn't have an easy way to remove by field.
    // We search for the file path in the 'file' field.
    // We use a strict search if possible, or just filter results.
    const results = this.index.search(file, {
      fields: ["file"],
      combineWith: "AND",
    });

    let removed = false;
    for (const res of results) {
      // Check for exact match to avoid issues with paths being tokens
      if (res.file === file) {
        try {
          this.index.remove(res);
          removed = true;
        } catch {
          // Document might not be in the index or already removed
        }
      }
    }

    if (removed) {
      this.dirty = true;
    }
  }

  search(query: string, limit: number): unknown[] {
    return this.index.search(query, { limit });
  }
}
