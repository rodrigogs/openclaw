/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFile, mkdir, mkdtemp, rm, stat as statActual } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { KnowledgeGraph } from "../index.ts";

describe("KnowledgeGraph", () => {
  it("extracts wikilinks", () => {
    const kg = new KnowledgeGraph("/tmp");
    const links = kg.extractLinks("Hello [[World]] and [[Universe|Cosmos]]");
    expect(links).toEqual(["World", "Universe"]);
  });

  it("updates graph and backlinks", async () => {
    const base = join(tmpdir(), `memory-qdrant-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    const kg = new KnowledgeGraph(base);

    kg.updateFile("a.md", "Link to [[b.md]]");
    kg.updateFile("b.md", "Back to [[a.md]]");

    const a = kg.getRelated("a.md");
    const b = kg.getRelated("b.md");

    expect(a.links).toContain("b.md");
    expect(a.backlinks).toContain("b.md");
    expect(b.links).toContain("a.md");
    expect(b.backlinks).toContain("a.md");
  });

  it("finds orphans", () => {
    const kg = new KnowledgeGraph("/tmp");
    kg.updateFile("orphan.md", "I link to [[hub.md]]");
    kg.updateFile("hub.md", "I am popular");

    const orphans = kg.getOrphans();
    expect(orphans).toContain("orphan.md");
    expect(orphans).not.toContain("hub.md");
  });

  it("handles load errors", async () => {
    const base = join(tmpdir(), `memory-kg-err-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await mkdir(join(base, ".memory-qdrant"), { recursive: true });
    await writeFile(join(base, ".memory-qdrant", "graph.json"), "invalid json");

    const kg = new KnowledgeGraph(base);
    await kg.load(); // Should not throw
    kg.updateFile("a.md", "[[b.md]]");
    expect(kg.getOrphans()).toContain("a.md");
  });
});

describe("KnowledgeGraph error handling", () => {
  it("load handles missing graph file gracefully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);
    await expect(graph.load()).resolves.toBeUndefined();
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("KnowledgeGraph advanced", () => {
  it("correctly ignores wikilinks in code blocks", () => {
    const graph = new KnowledgeGraph("/tmp");

    const contentWithCode = `
# Document

Some paragraph.

\`\`\`
[[This is not a link]]
\`\`\`

[[RealLink|This is a real link]]
    `;

    graph.updateFile("test.md", contentWithCode);
    const node = (graph as any).nodes.get("test.md");

    expect(node.links).toContain("RealLink");
    expect(node.links.some((l: string) => l.includes("This is not"))).toBe(false);
  });

  it("handles escaped bracket syntax", () => {
    const graph = new KnowledgeGraph("/tmp");

    const contentWithEscape = `
[[ValidLink]]
\\[[Not a real link]]
\`[[Another fake link]]\`
    `;

    graph.updateFile("test.md", contentWithEscape);
    const node = (graph as any).nodes.get("test.md");

    expect(node.links.length).toBe(1);
    expect(node.links[0]).toBe("ValidLink");
  });

  it("save skips save when not dirty", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);

    await graph.load();
    await graph.save();

    const graphPath = join(tempDir, ".memory-qdrant", "graph.json");
    await expect(statActual(graphPath)).rejects.toThrow();

    await rm(tempDir, { recursive: true, force: true });
  });

  it("updates backlinks correctly when links change", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);

    graph.updateFile("file1.md", "# File 1\n[[file2.md]] and [[file3.md]]");
    graph.updateFile("file1.md", "# File 1\n[[file2.md]] and [[file4.md]]");

    const file3Node = graph.nodes.get("file3.md");
    expect(file3Node?.backlinks).not.toContain("file1.md");

    const file4Node = graph.nodes.get("file4.md");
    expect(file4Node?.backlinks).toContain("file1.md");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps nodes with backlinks as ghosts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);

    graph.updateFile("file1.md", "# File 1\n[[file2.md]]");
    graph.updateFile("file2.md", "Some content");
    graph.removeFile("file2.md");

    const file2Node = graph.nodes.get("file2.md");
    expect(file2Node).toBeDefined();
    expect(file2Node?.links).toEqual([]);
    expect(file2Node?.backlinks).toContain("file1.md");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not save when not dirty", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);

    graph.nodes.set("test.md", { file: "test.md", links: [], backlinks: [] });

    await graph.save();

    const graphPath = join(tempDir, ".memory-qdrant", "graph.json");
    try {
      await statActual(graphPath);
      expect.fail("File should not exist");
    } catch (err) {
      expect(err).toBeDefined();
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps nodes with backlinks as ghosts (via removeFile)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "memory-qdrant-"));
    const graph = new KnowledgeGraph(tempDir);

    graph.updateFile("file1.md", "[[file2.md]]");
    graph.removeFile("file2.md");

    const file2Node = graph.nodes.get("file2.md");
    expect(file2Node).toBeDefined();
    expect(file2Node?.links).toEqual([]);
    expect(file2Node?.backlinks).toContain("file1.md");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("extra coverage: knowledge graph and text index details", async () => {
    const base = join(tmpdir(), `memory-extra-${Date.now()}`);
    await mkdir(base, { recursive: true });

    const kg = new KnowledgeGraph(base);
    kg.updateFile("a", "[[b]] [[c|Alias]]");
    kg.updateFile("b", "[[a]]");

    kg.removeFile("b");
    expect(kg.getRelated("a").links).toContain("b");

    kg.removeFile("c");

    expect(kg.getRelated("a.md").links).toHaveLength(2);

    kg.updateFile("dir/file", "link");
    expect(kg.getRelated("file.md").links).toHaveLength(0);
  });
});
