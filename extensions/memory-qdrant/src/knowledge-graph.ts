import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// Graph Knowledge (WikiLinks)
// ============================================================================

type GraphNode = {
  file: string;
  links: string[]; // Outgoing links (filenames or titles)
  backlinks: string[]; // Incoming links (files that link to this one)
};

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private graphPath: string;
  private dirty = false;

  constructor(workspacePath: string) {
    this.graphPath = join(workspacePath, ".memory-qdrant", "graph.json");
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.graphPath, "utf-8");
      const raw = JSON.parse(data) as Record<string, GraphNode>;
      this.nodes = new Map(Object.entries(raw));
    } catch {
      // Graph doesn't exist yet; ensure directory exists
      await mkdir(join(this.graphPath, ".."), { recursive: true });
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const obj = Object.fromEntries(this.nodes);
    await mkdir(join(this.graphPath, ".."), { recursive: true });
    await writeFile(this.graphPath, JSON.stringify(obj, null, 2));
    this.dirty = false;
  }

  extractLinks(text: string): string[] {
    // Remove code blocks and inline code before extracting links
    // This prevents false positives from [[  ]] in code examples
    const codeBlockRemoved = text
      .replace(/```[\s\S]*?```/g, "") // Remove code blocks
      .replace(/`[^`]+`/g, ""); // Remove inline code

    const regex = /\[\[(.*?)\]\]/g;
    const links: string[] = [];
    let match;
    while ((match = regex.exec(codeBlockRemoved)) !== null) {
      // Check for escape character before the match
      if (match.index > 0 && codeBlockRemoved[match.index - 1] === "\\") {
        continue;
      }

      // Handle aliases [[Link|Alias]]
      const link = match[1].split("|")[0].trim();
      // Skip empty links
      if (link) {
        links.push(link);
      }
    }
    return links;
  }

  updateFile(file: string, text: string): void {
    const links = this.extractLinks(text);

    // Update current node
    const existing = this.nodes.get(file);
    const oldLinks = existing ? existing.links : [];

    this.nodes.set(file, {
      file,
      links,
      backlinks: existing ? existing.backlinks : [],
    });

    // Update backlinks
    // 1. Remove old backlinks
    for (const oldLink of oldLinks) {
      if (!links.includes(oldLink)) {
        this.removeBacklink(oldLink, file);
      }
    }

    // 2. Add new backlinks
    for (const link of links) {
      if (!oldLinks.includes(link)) {
        this.addBacklink(link, file);
      }
    }

    this.dirty = true;
  }

  private addBacklink(target: string, source: string): void {
    // We normalize targets to potentially match files
    // For now, we store exactly what was linked
    const node = this.nodes.get(target) || { file: target, links: [], backlinks: [] };
    if (!node.backlinks.includes(source)) {
      node.backlinks.push(source);
      this.nodes.set(target, node);
    }
  }

  private removeBacklink(target: string, source: string): void {
    const node = this.nodes.get(target);
    if (node) {
      node.backlinks = node.backlinks.filter((b) => b !== source);
      this.nodes.set(target, node);
    }
  }

  removeFile(file: string): void {
    const node = this.nodes.get(file);
    if (!node) {
      return;
    }

    // Remove backlinks from outgoing links
    for (const link of node.links) {
      this.removeBacklink(link, file);
    }

    // Note: We don't remove the node entirely if it has backlinks pointing to it
    // It becomes a "ghost" node (referenced but not existing file)
    if (node.backlinks.length === 0) {
      this.nodes.delete(file);
    } else {
      // Just clear outgoing links
      node.links = [];
      this.nodes.set(file, node);
    }
    this.dirty = true;
  }

  getRelated(file: string): { links: string[]; backlinks: string[] } {
    // Try exact match, then try with/without extension, then fuzzy
    // For Obsidian, links usually don't have .md

    // 1. Try exact
    let node = this.nodes.get(file);

    // 2. Try removing extension
    if (!node && file.endsWith(".md")) {
      node = this.nodes.get(file.slice(0, -3));
    }

    // 3. Try finding by basename (e.g. "Projects/Foo.md" -> link "Foo")
    if (!node) {
      // Reverse search: find a key that ends with the basename
      const basename = file.split("/").pop()?.replace(".md", "");
      if (basename) {
        for (const [key, value] of this.nodes) {
          if (key === basename || key.endsWith("/" + basename)) {
            node = value;
            break;
          }
        }
      }
    }

    if (!node) {
      return { links: [], backlinks: [] };
    }
    return { links: node.links, backlinks: node.backlinks };
  }

  /**
   * Get outgoing links for a file (wikilinks)
   */
  getLinks(file: string): string[] {
    const related = this.getRelated(file);
    return related.links;
  }

  getOrphans(): string[] {
    const orphans: string[] = [];
    for (const [file, node] of this.nodes) {
      if (node.backlinks.length === 0) {
        orphans.push(file);
      }
    }
    return orphans;
  }
}
