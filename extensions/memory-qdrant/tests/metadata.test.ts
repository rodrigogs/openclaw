/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { parseYamlFrontmatter, inferCategory, extractHeaders } from "../index.ts";

describe("YAML Frontmatter & Wikilinks Extraction", () => {
  it("parseYamlFrontmatter extracts tags", () => {
    const text = `---
type: project
status: active
tags: [rust, cli, devtools]
---
# Content`;
    const { tags, metadata } = parseYamlFrontmatter(text);
    expect(tags).toContain("rust");
    expect(tags).toContain("cli");
    expect(metadata.type).toBe("project");
    expect(metadata.status).toBe("active");
  });

  it("inferCategory works for vault paths", () => {
    expect(inferCategory("vault/01 Journal/2026-02-05.md")).toBe("journal");
    expect(inferCategory("vault/02 Topics/Projects/openclaw.md")).toBe("project");
    expect(inferCategory("vault/03 People/Rodrigo.md")).toBe("person");
    expect(inferCategory("memory/2026-02-05.md")).toBe("session");
    expect(inferCategory("MEMORY.md")).toBe("core");
  });

  it("extractHeaders captures markdown headers", () => {
    const text = `# Main Title
## Subsection
### Details
Some content`;
    const headers = extractHeaders(text);
    expect(headers).toContain("main title");
    expect(headers).toContain("subsection");
    expect(headers).toContain("details");
  });

  it("payload includes tags, links, and category", async () => {
    const chunk = {
      file: "vault/02 Topics/Projects/openclaw.md",
      startLine: 1,
      endLine: 50,
      text: `---
type: project
status: stable
tags: [typescript, plugin]
---
# OpenClaw
See [[MEMORY.md]] and [[memory-qdrant]].
`,
      hash: "abc123",
    };

    const { tags, metadata } = parseYamlFrontmatter(chunk.text);
    const headers = extractHeaders(chunk.text);
    const category = inferCategory(chunk.file);
    const finalTags = [...new Set([...tags, ...headers])];

    expect(finalTags).toContain("typescript");
    expect(finalTags).toContain("plugin");
    expect(finalTags).toContain("openclaw");
    expect(category).toBe("project");
    expect(metadata.status).toBe("stable");
  });

  it("parseYamlFrontmatter handles array values", () => {
    const text = `---
tags: [a, b, c]
categories: [dev, test]
---
Content`;
    const { tags, metadata: _metadata } = parseYamlFrontmatter(text);
    expect(tags).toContain("a");
    expect(tags).toContain("b");
    expect(tags).toContain("c");
  });

  it("inferCategory handles vault Topics path", () => {
    expect(inferCategory("vault/02 Topics/research.md")).toBe("knowledge");
  });

  it("inferCategory handles vault Journal path", () => {
    expect(inferCategory("vault/01 Journal/2026-02-06.md")).toBe("journal");
  });

  it("inferCategory handles vault Projects path", () => {
    expect(inferCategory("vault/Projects/myproject.md")).toBe("project");
  });

  it("inferCategory handles vault People path", () => {
    expect(inferCategory("vault/03 People/Alice.md")).toBe("person");
  });

  it("inferCategory handles memory path", () => {
    expect(inferCategory("memory/session-123.md")).toBe("session");
  });

  it("inferCategory handles core files", () => {
    expect(inferCategory("SOUL.md")).toBe("core");
    expect(inferCategory("USER.md")).toBe("core");
  });

  it("inferCategory defaults to other", () => {
    expect(inferCategory("random/file.md")).toBe("other");
  });
});

describe("Additional frontmatter edge cases", () => {
  it("parseYamlFrontmatter handles non-array, non-boolean string values", () => {
    const text = `---
title: My Document
author: John Doe
---
Content`;
    const result = parseYamlFrontmatter(text);
    expect(result.metadata.title).toBe("My Document");
    expect(result.metadata.author).toBe("John Doe");
  });

  it("parseYamlFrontmatter stores plain text values", () => {
    const text = `---
description: This is a plain text description
---`;
    const result = parseYamlFrontmatter(text);
    expect(result.metadata.description).toBe("This is a plain text description");
  });
});
