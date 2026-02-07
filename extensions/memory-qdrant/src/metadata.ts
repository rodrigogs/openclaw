// ============================================================================
// YAML Frontmatter & Tags Extraction
// ============================================================================

export function parseYamlFrontmatter(text: string): {
  tags: string[];
  metadata: Record<string, unknown>;
} {
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { tags: [], metadata: {} };
  }

  const frontmatterText = frontmatterMatch[1];
  const metadata: Record<string, unknown> = {};
  const tags: string[] = [];

  // Extract YAML fields: type: project, status: active, tags: [a, b, c], etc.
  const lines = frontmatterText.split("\n");
  for (const line of lines) {
    const [key, ...valueParts] = line.split(":");
    if (!key || !valueParts.length) {
      continue;
    }
    const value = valueParts.join(":").trim();

    // Parse tags
    if (key.trim() === "tags") {
      const tagMatch = value.match(/\[(.*?)\]/);
      if (tagMatch) {
        tags.push(...tagMatch[1].split(",").map((t) => t.trim().replace(/['"]/g, "")));
      }
    }

    // Store other frontmatter fields
    if (value.startsWith("[")) {
      try {
        metadata[key.trim()] = JSON.parse(value);
      } catch {
        metadata[key.trim()] = value;
      }
    } else if (value === "true" || value === "false") {
      metadata[key.trim()] = value === "true";
    } else {
      metadata[key.trim()] = value;
    }
  }

  return { tags, metadata };
}

export function inferCategory(filePath: string): string {
  if (filePath.startsWith("vault/")) {
    if (filePath.includes("Journal")) {
      return "journal";
    }
    if (filePath.includes("Projects")) {
      return "project";
    }
    if (filePath.includes("Topics")) {
      return "knowledge";
    }
    if (filePath.includes("People")) {
      return "person";
    }
    return "knowledge";
  }
  if (filePath.startsWith("memory/")) {
    return "session";
  }
  if (filePath === "MEMORY.md" || filePath === "SOUL.md" || filePath === "USER.md") {
    return "core";
  }
  return "other";
}

export function extractHeaders(text: string): string[] {
  const headerRegex = /^#+\s+(.+?)$/gm;
  const headers: string[] = [];
  let match;
  while ((match = headerRegex.exec(text)) !== null) {
    headers.push(
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ""),
    );
  }
  return headers;
}
