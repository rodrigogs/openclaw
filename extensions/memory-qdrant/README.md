# memory-qdrant

**Production-ready memory and knowledge management plugin for OpenClaw using Qdrant vector database, Ollama embeddings, and Obsidian vault integration.**

## Overview

The `memory-qdrant` plugin transforms your OpenClaw agent into a context-aware system with long-term memory. It provides:

- **📚 Obsidian Vault Integration** - Index your entire knowledge base (Markdown files + YAML frontmatter)
- **🔍 Hybrid Search** - Vector similarity (Qdrant) + BM25 text search (MiniSearch) + knowledge graph
- **🧠 Auto-Recall** - Automatically inject relevant memories before agent responses
- **💾 Auto-Capture** - Extract and store important facts from conversations (opt-in)
- **🔗 Knowledge Graph** - Track wikilinks `[[...]]` and backlinks across your vault
- **⏰ Recency Scoring** - Recent memories are weighted higher in search results
- **🎯 Smart Chunking** - Semantic text splitting with overlap for better retrieval
- **🚀 Production-Ready** - Health checks, error handling, graceful degradation

## Features

### Core Capabilities

- **Vector Search**: Semantic search using Qdrant vector database with HNSW indexing
- **Embeddings**: Ollama-powered embeddings (default: `nomic-embed-text`, 768 dimensions)
- **Text Search**: Fast BM25 search with MiniSearch when vector DB is unavailable
- **Knowledge Graph**: Automatic extraction of wikilinks, backlinks, and orphan detection
- **File Watching**: Real-time indexing with configurable debouncing (default: 1.5s)
- **Multi-Source Indexing**: Vault + workspace files + configurable extra paths
- **Metadata Support**: YAML frontmatter extraction (tags, categories, custom fields)

### Auto-Recall (Memory Injection)

Automatically injects relevant memories into the agent's context before responses.

**How it works:**

1. Agent receives a prompt (e.g., "What's my email?")
2. Plugin embeds the prompt and searches for similar memories
3. Top N results (default: 3) above threshold (default: 0.4) are injected
4. Agent responds with full context

**Configuration:**

```json
{
  "autoRecall": true,
  "autoRecallLimit": 3,
  "autoRecallMinScore": 0.4
}
```

### Auto-Capture (Memory Extraction)

⚠️ **Disabled by default** - Automatically extracts facts from conversations and stores them.

**Triggers:**

- Explicit: "Remember my email is test@example.com"
- Preferences: "I prefer TypeScript over JavaScript"
- Facts: "My birthday is May 10"
- Decisions: "We decided to use Docker"

**Safety Features:**

- Rate limiting (default: 3 captures per 5-minute window per conversation)
- Duplicate detection (similarity threshold: 0.92)
- Pattern-based filtering (excludes code blocks, XML, lists)

**Configuration:**

```json
{
  "autoCapture": true,
  "autoCaptureMaxPerWindow": 3,
  "autoCaptureWindowMs": 300000,
  "autoCaptureDupThreshold": 0.92
}
```

### Recency Scoring

Recent memories are automatically boosted in search results using exponential decay.

**How it works:**

- Captured memories include `capturedAt` timestamp
- Search applies decay: `finalScore = vectorScore × (1 - weight) + decayScore × weight`
- Half-life: 30 days (configurable)
- Default weight: 0.2 (20% recency influence)

**Configuration:**

```json
{
  "recencyEnabled": true,
  "recencyHalfLifeDays": 30,
  "recencyWeight": 0.2
}
```

### Knowledge Graph

Automatic wikilink extraction and backlink tracking.

**Features:**

- Extracts `[[wikilinks]]` from Markdown
- Tracks bidirectional relationships
- Detects orphan notes (no incoming/outgoing links)
- Handles aliases: `[[Link|Alias]]`
- Escapes: `\[[not a link]]`

**Tools:**

- `memory_organize` - Find and report orphaned notes

## Tools

### Memory Management

- **`memory_search`** - Search across vault, workspace, and captured memories
  - Hybrid: vector + text + knowledge graph
  - Returns: snippets, file paths, line numbers, scores
- **`memory_get`** - Retrieve file contents with optional line ranges
  - Sources: `vault`, `workspace`, `extra`, `captured`
  - Blocks path traversal (security)

### Captured Memories

- **`memory_captured_list`** - List all captured facts (chronological)
- **`memory_captured_delete`** - Delete specific captured memory by ID
- **`memory_captured_export`** - Export to Obsidian inbox note

### Organization

- **`memory_organize`** - Analyze vault structure
  - Detects orphan notes
  - Reports statistics (total files, links, backlinks)
  - `dryRun` option for preview

## Architecture

### Components

```
┌─────────────────────────────────────────────────────┐
│                  OpenClaw Agent                      │
└──────────────────┬──────────────────────────────────┘
                   │
      ┌────────────┴─────────────┐
      │   memory-qdrant Plugin   │
      └────────┬─────────────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
┌───▼───┐  ┌──▼───┐  ┌──▼────┐
│Qdrant │  │Ollama│  │MiniSrch│
│Vector │  │Embed │  │BM25   │
└───────┘  └──────┘  └───────┘
    │          │          │
    └──────────┼──────────┘
               │
        ┌──────▼──────┐
        │  Obsidian   │
        │    Vault    │
        └─────────────┘
```

### Data Flow

1. **Indexing:**
   - Watch vault files for changes
   - Extract text, frontmatter, wikilinks
   - Generate embeddings via Ollama
   - Store in Qdrant + MiniSearch + KnowledgeGraph

2. **Search:**
   - Embed query → Qdrant vector search (cosine similarity)
   - Text query → MiniSearch BM25 search
   - Merge results with hybrid scoring (0.7 vector + 0.3 text)
   - Apply recency decay if enabled
   - Return top N results

3. **Auto-Recall:**
   - Hook: `before_agent_start`
   - Timeout: 3 seconds (AbortSignal)
   - Inject as `<relevant-memories>` XML block

4. **Auto-Capture:**
   - Hook: `message_received`
   - Pattern matching + duplicate detection
   - Rate limiting per conversation
   - Store in Qdrant with `captured/` prefix

### Performance

- **Scalar Quantization**: 4× memory reduction (int8 quantization, 99th percentile)
- **Payload Indexes**: Keyword indexes on `file`, `category`, `source` fields
- **Batch Embeddings**: Bulk `/api/embed` API with fallback
- **Caching**: Dimension caching, dirty flag for saves
- **Debouncing**: File watcher batches changes (configurable)

### Reliability

- **Health Checks**: Validates Qdrant + Ollama connectivity at startup
  - Clear error messages: "Qdrant not reachable at localhost:6333 — is it running?"
- **Graceful Degradation**: Falls back to text search if vector DB unavailable
- **Safe ID Generation**: 53-bit masked BigInt (prevents ID collisions)
- **Error Handling**: Try-catch blocks with logging, never crashes agent
- **Cleanup**: Periodic captureWindow cleanup (5-minute interval)

### Storage

- **Qdrant Collection**: Vector embeddings + payloads (text, metadata)
- **MiniSearch Index**: `.memory-qdrant/index.json` (BM25 text search)
- **Knowledge Graph**: `.memory-qdrant/graph.json` (wikilinks + backlinks)
- **Captured Memories**: Stored in Qdrant with `captured/` source prefix

## Installation

### Prerequisites

1. **Qdrant** (vector database)

   ```bash
   docker run -p 6333:6333 qdrant/qdrant
   ```

2. **Ollama** (embeddings)

   ```bash
   curl https://ollama.ai/install.sh | sh
   ollama pull nomic-embed-text
   ```

3. **Obsidian Vault** (or any Markdown directory)

### Plugin Installation

The plugin is built-in to OpenClaw. Enable it in your configuration:

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/path/to/obsidian-vault",
      "workspacePath": "/path/to/workspace"
    }
  }
}
```

## Configuration

See [CONFIG.md](./CONFIG.md) for complete configuration reference.

### Quick Start

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/vault",
      "workspacePath": "/home/user/openclaw",
      "autoRecall": true,
      "autoRecallLimit": 3,
      "autoRecallMinScore": 0.4,
      "autoCapture": false
    }
  }
}
```

### Environment Variables (Optional)

```bash
export QDRANT_URL=http://localhost:6333
export OLLAMA_URL=http://localhost:11434
```

## Usage Examples

### Search Across Vault

```typescript
await agent.useTool("memory_search", {
  query: "machine learning notes",
  limit: 5,
  minScore: 0.5,
});
```

Response:

```json
{
  "results": [
    {
      "file": "vault/Notes/ML-Basics.md",
      "snippet": "Machine learning is a subset of AI...",
      "score": 0.87,
      "startLine": 15,
      "endLine": 18,
      "source": "vault"
    }
  ]
}
```

### Capture Important Facts

```typescript
// User message (auto-captured if enabled):
"Remember my email is john@example.com"

// Stored in Qdrant:
{
  id: "captured-1234567890",
  text: "Remember my email is john@example.com",
  category: "personal",
  capturedAt: 1675123456789,
  sessionKey: "session-abc"
}
```

### Find Orphan Notes

```typescript
await agent.useTool("memory_organize", {
  dryRun: true,
});
```

Response:

```json
{
  "details": {
    "orphans": ["vault/drafts/unused-note.md"],
    "stats": {
      "totalFiles": 450,
      "withLinks": 398,
      "orphans": 52
    }
  }
}
```

## Troubleshooting

### Common Issues

**"Module not found" errors**

- Run `pnpm install` in `extensions/memory-qdrant/`

**"Ollama connection refused"**

- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Check model exists: `ollama list | grep nomic-embed-text`

**"Qdrant not reachable"**

- Check Docker container: `docker ps | grep qdrant`
- Verify port 6333 is exposed: `curl http://localhost:6333`

**Slow indexing**

- Increase `watcherDebounceMs` to 3000+ (batch changes)
- Set `autoIndex: false` for large vaults
- Use manual indexing via cron

**Duplicate memories**

- Increase `autoCaptureDupThreshold` (0.95+ for strict)
- Reduce `autoCaptureMaxPerWindow` (e.g., 2 instead of 3)

### Debug Logging

Enable verbose logging in OpenClaw:

```json
{
  "logging": {
    "level": "debug",
    "filters": ["memory-qdrant"]
  }
}
```

Check logs for:

- `memory-qdrant: initialized` - Service started
- `memory-qdrant: indexing started` - File watcher triggered
- `memory-qdrant: auto-recall injecting N memories` - Memories injected
- `memory-qdrant: auto-captured [category]` - Fact captured

## Performance Benchmarks

### Indexing Speed

- **Small vault** (100 notes): ~5 seconds
- **Medium vault** (1000 notes): ~45 seconds
- **Large vault** (10,000 notes): ~8 minutes

_Tested on: Ryzen 5950X, 32GB RAM, NVMe SSD_

### Search Latency

- **Vector search**: 20-50ms (depends on collection size)
- **Text search**: 5-10ms (MiniSearch in-memory)
- **Hybrid search**: 30-60ms (parallel)
- **Auto-recall**: < 100ms (with 3-second timeout)

### Memory Usage

- **Base plugin**: ~50MB
- **MiniSearch index**: ~5MB per 1000 notes
- **Knowledge graph**: ~2MB per 1000 notes
- **Qdrant collection**: Depends on vectors (768 dims: ~3KB per chunk)

## Development

### Running Tests

```bash
# All tests
pnpm test extensions/memory-qdrant/index.test.ts

# Watch mode
pnpm test:watch extensions/memory-qdrant/index.test.ts

# Coverage
pnpm test:coverage extensions/memory-qdrant/index.test.ts
```

Current test coverage: **169 tests (100% passing)**

### Linting

```bash
pnpm oxlint extensions/memory-qdrant/
pnpm oxlint --fix extensions/memory-qdrant/
```

### Project Structure

```
extensions/memory-qdrant/
├── README.md              # This file
├── CONFIG.md              # Configuration reference
├── index.ts               # Main plugin implementation (1978 lines)
├── index.test.ts          # Test suite (3390 lines, 169 tests)
├── index.d.ts             # TypeScript declarations
├── openclaw.plugin.json   # Plugin metadata
├── package.json           # Dependencies
└── node_modules/          # Dependencies
```

## Recent Improvements (v2026.2.6)

### P0 Fixes (Critical)

- ✅ **BigInt ID Collision**: Safe 53-bit ID generation prevents overwrites
- ✅ **Payload Indexes + Quantization**: 4× faster filtered queries, 4× less memory

### P1 Fixes (High Priority)

- ✅ **Batch Embeddings**: N× faster indexing via bulk HTTP API
- ✅ **Recency Scoring**: Time-aware search with exponential decay
- ✅ **Health Checks**: Clear startup errors for Qdrant/Ollama

### P2/P3 Fixes (Nice-to-Have)

- ✅ **CaptureWindow Cleanup**: Prevents slow memory leak
- ✅ **AbortSignal.timeout()**: Cleaner timeout handling (Node 22+)
- ✅ **Persistence Subdirectory**: Cleaner workspace (`.memory-qdrant/`)

## Contributing

When contributing to this plugin:

1. Run tests: `pnpm test extensions/memory-qdrant/index.test.ts`
2. Maintain 100% test pass rate
3. Add tests for new features
4. Follow existing code style (oxlint)
5. Update CONFIG.md for new options
6. Keep README.md in sync

## License

Part of OpenClaw project - see main repository license.

## Links

- [OpenClaw Repository](https://github.com/openclaw/openclaw)
- [Configuration Reference](./CONFIG.md)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [Ollama Documentation](https://ollama.ai/docs)
- [Obsidian](https://obsidian.md/)

---

**Built with ❤️ for the OpenClaw community**
