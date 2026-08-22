import { z } from "zod";
import { titleKey } from "./naming.ts";
import { isEntityPath, type Note, wikilinkTarget } from "./notes.ts";

export const entityTypes = [
  "file",
  "module",
  "decision",
  "convention",
  "tool",
  "dependency",
  "person",
  "error-pattern",
  "task",
] as const;

export const predicates = [
  "applies_to",
  "authored_by",
  "blocks",
  "causes",
  "consolidated_by",
  "consolidates",
  "contradicts",
  "decided_against",
  "decided_for",
  "depends_on",
  "fixes",
  "part_of",
  "relates_to",
  "supersedes",
  "superseded_by",
  "uses",
] as const;

export const entityTypeSchema = z.enum(entityTypes);
export const predicateSchema = z.enum(predicates);
export type EntityType = z.infer<typeof entityTypeSchema>;
export type Predicate = z.infer<typeof predicateSchema>;

export interface GraphNode {
  name: string;
  aliases: string[];
  type?: EntityType;
}

export interface GraphEdge {
  subject: string;
  predicate: Predicate;
  object: string;
}

export interface DanglingLink {
  from: string;
  predicate: Predicate;
  to: string;
}

export interface SkippedRelation {
  note: string;
  predicate: Predicate;
  value: string;
}

export interface OutlineEntry {
  name: string;
  predicate: Predicate;
  direction: "out" | "in";
  depth: number;
}

export interface RankedEntity {
  name: string;
  score: number;
}

export interface PageRankOptions {
  damping?: number;
  iterations?: number;
}

export class MemoryGraph {
  static fromNotes(notes: readonly Note[]): MemoryGraph {
    return new GraphBuilder(notes).build();
  }

  constructor(
    private readonly byKey: Map<string, GraphNode>,
    private readonly lookup: Map<string, string>,
    readonly edges: readonly GraphEdge[],
    readonly danglingLinks: readonly DanglingLink[],
    readonly skippedRelations: readonly SkippedRelation[],
  ) {}

  get edgeCount(): number {
    return this.edges.length;
  }

  nodes(): GraphNode[] {
    return [...this.byKey.values()];
  }

  resolve(reference: string): GraphNode | undefined {
    const name = this.lookup.get(titleKey(reference));
    return name === undefined ? undefined : this.byKey.get(titleKey(name));
  }

  contradictionsOf(reference: string): string[] {
    const node = this.resolve(reference);
    if (node === undefined) return [];
    const key = titleKey(node.name);
    const names: string[] = [];
    for (const edge of this.edges) {
      if (edge.predicate !== "contradicts") continue;
      const other = this.otherEnd(edge, key);
      if (other !== undefined && !names.includes(other)) names.push(other);
    }
    return names;
  }

  outline(reference: string, maxDepth: 1 | 2 = 1): OutlineEntry[] {
    const origin = this.resolve(reference);
    if (origin === undefined) return [];
    const seen = new Set([titleKey(origin.name)]);
    const entries: OutlineEntry[] = [];
    let frontier = [origin.name];
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next: string[] = [];
      for (const name of frontier) {
        for (const step of this.touching(name)) {
          if (seen.has(titleKey(step.name))) continue;
          seen.add(titleKey(step.name));
          entries.push({ ...step, depth });
          next.push(step.name);
        }
      }
      frontier = next;
    }
    return entries;
  }

  rank(seedReferences: readonly string[], options: PageRankOptions = {}): RankedEntity[] {
    const damping = options.damping ?? 0.85;
    const iterations = options.iterations ?? 15;
    const seedKeys = this.resolveSeedKeys(seedReferences);
    if (seedKeys.length === 0 || this.edges.length === 0) return [];
    const keys = [...this.byKey.keys()];
    const neighbors = this.neighborIndex(keys);
    const personalization = keys.map((key) => (seedKeys.includes(key) ? 1 / seedKeys.length : 0));
    let scores = [...personalization];
    for (let step = 0; step < iterations; step += 1) {
      scores = spread(scores, personalization, neighbors, damping);
    }
    return keys
      .map((key, at) => ({ name: this.byKey.get(key)?.name ?? key, score: scores[at] ?? 0 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  private resolveSeedKeys(references: readonly string[]): string[] {
    const keys: string[] = [];
    for (const reference of references) {
      const node = this.resolve(reference);
      if (node === undefined) continue;
      const key = titleKey(node.name);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  private neighborIndex(keys: string[]): number[][] {
    const index = new Map(keys.map((key, at) => [key, at]));
    const neighbors: number[][] = keys.map(() => []);
    for (const [a, b] of this.undirectedPairs()) {
      const from = index.get(a);
      const to = index.get(b);
      if (from === undefined || to === undefined) continue;
      neighbors[from]?.push(to);
      neighbors[to]?.push(from);
    }
    return neighbors;
  }

  private *undirectedPairs(): Generator<[string, string]> {
    const seen = new Set<string>();
    for (const edge of this.edges) {
      const a = titleKey(edge.subject);
      const b = titleKey(edge.object);
      if (a === b) continue;
      const pair = a < b ? `${a}\0${b}` : `${b}\0${a}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      yield [a, b];
    }
  }

  private touching(
    name: string,
  ): { name: string; predicate: Predicate; direction: "out" | "in" }[] {
    const key = titleKey(name);
    const steps: { name: string; predicate: Predicate; direction: "out" | "in" }[] = [];
    for (const edge of this.edges) {
      if (titleKey(edge.subject) === key) {
        steps.push({ name: edge.object, predicate: edge.predicate, direction: "out" });
      } else if (titleKey(edge.object) === key) {
        steps.push({ name: edge.subject, predicate: edge.predicate, direction: "in" });
      }
    }
    return steps;
  }

  private otherEnd(edge: GraphEdge, key: string): string | undefined {
    if (titleKey(edge.subject) === key) return edge.object;
    if (titleKey(edge.object) === key) return edge.subject;
    return undefined;
  }
}

function spread(
  scores: number[],
  personalization: number[],
  neighbors: number[][],
  damping: number,
): number[] {
  const next = personalization.map((p) => (1 - damping) * p);
  let strandedMass = 0;
  scores.forEach((score, at) => {
    const out = neighbors[at] ?? [];
    if (out.length === 0) {
      strandedMass += score;
      return;
    }
    const share = (damping * score) / out.length;
    for (const to of out) next[to] = (next[to] ?? 0) + share;
  });
  if (strandedMass > 0) {
    personalization.forEach((p, at) => {
      next[at] = (next[at] ?? 0) + damping * strandedMass * p;
    });
  }
  return next;
}

class GraphBuilder {
  private readonly byKey = new Map<string, GraphNode>();
  private readonly lookup = new Map<string, string>();
  private readonly edges: GraphEdge[] = [];
  private readonly edgeKeys = new Set<string>();
  private readonly dangling: DanglingLink[] = [];
  private readonly skipped: SkippedRelation[] = [];

  constructor(private readonly notes: readonly Note[]) {}

  build(): MemoryGraph {
    for (const note of this.notes) this.addNode(note);
    for (const note of this.notes) {
      for (const link of note.links) this.addEdge(note.name, "relates_to", link);
      this.addTypedRelations(note);
    }
    return new MemoryGraph(this.byKey, this.lookup, this.edges, this.dangling, this.skipped);
  }

  private addNode(note: Note): void {
    const type = declaredType(note) ?? impliedType(note);
    this.byKey.set(titleKey(note.name), {
      name: note.name,
      aliases: note.aliases,
      ...(type !== undefined && { type }),
    });
    for (const reference of [note.name, note.title, ...note.aliases]) {
      const key = titleKey(reference);
      if (!this.lookup.has(key)) this.lookup.set(key, note.name);
    }
  }

  private addTypedRelations(note: Note): void {
    for (const predicate of predicates) {
      const value = note.frontmatter[predicate];
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        const target = wikilinkTarget(item);
        if (target === undefined) {
          this.skipped.push({ note: note.name, predicate, value: String(item) });
          continue;
        }
        this.addEdge(note.name, predicate, target);
      }
    }
  }

  private addEdge(from: string, predicate: Predicate, to: string): void {
    const target = this.lookup.get(titleKey(to));
    if (target === undefined) {
      this.dangling.push({ from, predicate, to });
      return;
    }
    const edgeKey = `${titleKey(from)}\0${predicate}\0${titleKey(target)}`;
    if (this.edgeKeys.has(edgeKey)) return;
    this.edgeKeys.add(edgeKey);
    this.edges.push({ subject: from, predicate, object: target });
  }
}

function declaredType(note: Note): EntityType | undefined {
  const parsed = entityTypeSchema.safeParse(note.frontmatter.type);
  return parsed.success ? parsed.data : undefined;
}

function impliedType(note: Note): EntityType | undefined {
  return isEntityPath(note.path) ? "file" : undefined;
}
