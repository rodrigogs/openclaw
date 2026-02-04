# Memory-Qdrant Plugin Configuration

Complete guide for configuring the `memory-qdrant` plugin.

## Basic Setup

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "workspacePath": "/home/user/clawd"
    }
  }
}
```

## Full Configuration Options

### Vector Database

- **qdrantUrl** (string, default: `http://localhost:6333`)
  - URL of Qdrant vector database instance
  - Required: false (uses default)

- **collection** (string, default: `openclaw-memory`)
  - Name of Qdrant collection to store embeddings
  - Can be changed to isolate different memory spaces

- **ollamaUrl** (string, default: `http://localhost:11434`)
  - URL of Ollama embedding server
  - Supports custom ports and remote hosts

- **embeddingModel** (string, default: `nomic-embed-text`)
  - Ollama model for generating embeddings
  - Recommended: `nomic-embed-text`, `bge-small`, `all-minilm`

### Indexing

- **autoIndex** (boolean, default: `true`)
  - Automatically index vault on startup and watch for changes
  - Set to `false` for large vaults (manual indexing via cron)

- **extraPaths** (string[], default: `[]`)
  - Additional directories to index beyond vault/workspace
  - Example: `["/home/user/notes", "/home/user/projects"]`

- **watcherDebounceMs** (number, default: `1500`)
  - Milliseconds to wait after file change before re-indexing
  - Increase for very large directories (e.g., `5000`)
  - Decrease for fast iteration (e.g., `500`)

### Auto-Recall (Memory Injection)

When enabled, relevant memories are automatically injected into the agent's context before it responds.

- **autoRecall** (boolean, default: `true`)
  - Enable automatic injection of relevant memories

- **autoRecallLimit** (number, default: `3`)
  - Maximum number of memories to inject per query
  - Increase for more context (may reduce response speed)

- **autoRecallMinScore** (number, default: `0.4`)
  - Minimum relevance score (0–1) to inject
  - Lower = more aggressive recall, higher = only very relevant memories

### Auto-Capture (Memory Extraction)

Auto-capture extracts important facts from agent responses and stores them as memories. **Disabled by default for safety.**

- **autoCapture** (boolean, default: `false`)
  - Enable automatic capture of facts from responses
  - Set to `true` only after validating your use case

- **autoCaptureMax** (number, default: `3`)
  - Maximum facts to extract per response

- **autoCaptureDupThreshold** (number, default: `0.92`)
  - Similarity threshold (0–1) to detect duplicates
  - Prevents capturing nearly-identical facts

- **autoCaptureWindowMs** (number, default: `300000`)
  - 5-minute window: rate-limit captures within this timespan
  - Prevents capture spam from repetitive responses

- **autoCaptureMaxPerWindow** (number, default: `3`)
  - Maximum captures allowed per window

### Auto-Organization

Automatically detects orphaned notes (no incoming/outgoing links) and suggests organization.

- **autoOrganizeOrphans** (boolean, default: `true`)
  - Enable orphan detection and reporting

- **orphanThresholdMs** (number, default: `86400000`)
  - Milliseconds (24h default) before marking as orphan
  - A note is "orphan" if it has no links and hasn't been linked to for this duration

## Example Configurations

### Development (Fast Iteration)

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "workspacePath": "/home/user/clawd",
      "watcherDebounceMs": 500,
      "autoRecallLimit": 5,
      "autoRecallMinScore": 0.3
    }
  }
}
```

### Production (Large Vault)

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "workspacePath": "/home/user/clawd",
      "autoIndex": false,
      "watcherDebounceMs": 3000,
      "autoRecallLimit": 3,
      "autoRecallMinScore": 0.5,
      "autoCapture": false
    }
  }
}
```

### Privacy-Focused (No Capture)

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "workspacePath": "/home/user/clawd",
      "autoCapture": false,
      "autoOrganizeOrphans": false
    }
  }
}
```

## Environment Fallbacks

If Qdrant or Ollama are unavailable:

1. **Vector search disabled**: Falls back to text-only search
2. **Embedding generation fails**: Uses text index + knowledge graph only
3. **Text index unavailable**: Returns empty results (graceful degradation)

The plugin is designed to **never crash**, only degrade.

## Performance Tuning

### For Large Vaults (1000+ notes)

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "autoIndex": false,
      "watcherDebounceMs": 5000,
      "extraPaths": [],
      "autoRecallLimit": 2
    }
  }
}
```

Run indexing via cron once daily:
```bash
# In HEARTBEAT.md or a cron job
openclaw plugins memory-qdrant index
```

### For Real-Time Performance

```json
{
  "plugins": {
    "memory-qdrant": {
      "vaultPath": "/home/user/obsidian-vault",
      "watcherDebounceMs": 800,
      "autoRecallLimit": 4,
      "autoRecallMinScore": 0.35
    }
  }
}
```

## Troubleshooting

### "Ollama embed: 500" errors
- Check Ollama is running: `curl http://localhost:11434/api/tags`
- Verify model exists: `ollama list`
- Restart Ollama: `systemctl restart ollama`

### Memory search returns no results
- Verify vault path is correct: `ls /path/to/vault`
- Check plugin has read access: `ls -la /path/to/vault`
- Run manual index: `openclaw plugins memory-qdrant index`

### High CPU/Memory during indexing
- Increase `watcherDebounceMs` to batch file changes
- Set `autoIndex: false` and run indexing during off-peak hours
- Reduce `extraPaths` to only essential directories

### Duplicate memories being captured
- Increase `autoCaptureDupThreshold` (closer to 1.0)
- Reduce `autoCaptureMaxPerWindow`
- Set `autoCapture: false` if not needed

## API Reference

See [ARCHITECTURE.md](./ARCHITECTURE.md) for tool schemas and internal APIs.
