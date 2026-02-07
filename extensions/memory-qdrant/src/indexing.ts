import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { KnowledgeGraph } from "./knowledge-graph.ts";
import type { OllamaEmbeddings } from "./ollama-embeddings.ts";
import type { QdrantClient } from "./qdrant-client.ts";
import type { TextIndex } from "./text-index.ts";
import type { MemoryChunk } from "./types.ts";
import { generatePointId } from "./utils.ts";

// ============================================================================
// Chunking & Indexing
// ============================================================================

export function chunkText(text: string, targetWords = 400, overlapWords = 80): MemoryChunk[] {
  const MAX_LINE_CHARS = 2000;
  const rawLines = text.split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length <= MAX_LINE_CHARS) {
      lines.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
      lines.push(line.slice(i, i + MAX_LINE_CHARS));
    }
  }
  const chunks: MemoryChunk[] = [];
  let currentChunk: string[] = [];
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
        const overlapLines: string[] = [];
        for (let j = currentChunk.length - 1; j >= 0; j--) {
          const words = currentChunk[j].split(/\s+/).filter(Boolean).length;
          overlapCount += words;
          overlapLines.unshift(currentChunk[j]);
          if (overlapCount >= overlapWords) {
            break;
          }
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

export async function indexFile(
  filePath: string,
  relPath: string,
  qdrant: QdrantClient,
  embeddings: OllamaEmbeddings,
  textIndex?: TextIndex,
  knowledgeGraph?: KnowledgeGraph,
): Promise<number> {
  const content = await readFile(filePath, "utf-8");
  const chunks = chunkText(content);

  if (chunks.length === 0) {
    return 0;
  }

  // Set file and compute IDs
  const processedChunks = chunks.map((chunk) => {
    const id = generatePointId(`${relPath}:${chunk.startLine}-${chunk.endLine}`);
    const contentHash = createHash("sha256").update(chunk.text).digest("hex");
    return { ...chunk, id, file: relPath, hash: contentHash };
  });

  // Update Text Index (BM25)
  if (textIndex) {
    textIndex.removeByFile(relPath);
    textIndex.add(processedChunks);
  }

  // Update Knowledge Graph
  if (knowledgeGraph) {
    knowledgeGraph.updateFile(relPath, content);
  }

  // Generate embeddings and batch upsert (atomic delete + insert)
  const vectors = await embeddings.embedBatch(processedChunks.map((c) => c.text));
  await qdrant.batchUpsertFile(relPath, processedChunks, vectors, knowledgeGraph);

  return processedChunks.length;
}

export async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

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
  } catch {
    // Ignore permission errors, missing dirs
  }

  return files;
}

export async function indexDirectory(
  dir: string,
  prefix: string,
  qdrant: QdrantClient,
  embeddings: OllamaEmbeddings,
  logger: { info: (msg: string) => void },
  textIndex?: TextIndex,
  knowledgeGraph?: KnowledgeGraph,
): Promise<number> {
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
