// ============================================================================
// Ollama Embeddings
// ============================================================================

export class OllamaEmbeddings {
  private cachedDimensions: number | null = null;

  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
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

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Batch embed using Ollama's /api/embed endpoint (v0.4.0+).
   * Falls back to sequential /api/embeddings if the batch endpoint fails.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.length === 1) {
      const vec = await this.embed(texts[0]);
      return [vec];
    }

    try {
      const response = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama batch embed: ${response.status}`);
      }

      const data = (await response.json()) as { embeddings: number[][] };
      if (data.embeddings && data.embeddings.length === texts.length) {
        return data.embeddings;
      }
      // Unexpected response shape — fall through to sequential
    } catch {
      // Batch endpoint not available — fall back to sequential
    }

    return Promise.all(texts.map((text) => this.embed(text)));
  }

  /**
   * Get embedding dimensions. Cached after first call to avoid wasting an embed call.
   */
  async getDimensions(): Promise<number> {
    if (this.cachedDimensions !== null) {
      return this.cachedDimensions;
    }
    const testVector = await this.embed("test");
    this.cachedDimensions = testVector.length;
    return this.cachedDimensions;
  }

  /**
   * Health check: verify Ollama is reachable and the model is available.
   */
  async healthCheck(): Promise<void> {
    const response = await fetch(`${this.url}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama health check failed: ${response.status}`);
    }
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const modelExists = data.models?.some((m) => m.name === this.model);
    if (!modelExists) {
      throw new Error(
        `Ollama model "${this.model}" not found. Available: ${data.models?.map((m) => m.name).join(", ") || "none"}`,
      );
    }
  }
}
