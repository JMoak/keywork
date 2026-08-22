import type { Note } from "./notes.ts";

export interface BootstrapSelection {
  notes: Note[];
  tokens: number;
  budget: number;
  skipped: string[];
}

export interface BootstrapSource {
  bootstrap(tokenBudget: number): Promise<BootstrapSelection>;
}

export interface BootstrapLayer {
  name: string;
  store: BootstrapSource;
  budget: number;
}

export interface LayerBootstrap {
  name: string;
  selection: BootstrapSelection;
}

export interface BootstrapInjection {
  text: string;
  tokens: number;
  layers: LayerBootstrap[];
}

export async function bootstrapMemory(
  layers: readonly BootstrapLayer[],
): Promise<BootstrapInjection> {
  const resolved: LayerBootstrap[] = [];
  for (const layer of layers) {
    resolved.push({ name: layer.name, selection: await layer.store.bootstrap(layer.budget) });
  }
  return {
    text: renderInjection(resolved),
    tokens: resolved.reduce((sum, layer) => sum + layer.selection.tokens, 0),
    layers: resolved,
  };
}

export function selectWithinBudget(ordered: readonly Note[], budget: number): BootstrapSelection {
  const notes: Note[] = [];
  const skipped: string[] = [];
  let tokens = 0;
  for (const note of ordered) {
    if (tokens + note.tokens > budget) {
      skipped.push(note.name);
      continue;
    }
    notes.push(note);
    tokens += note.tokens;
  }
  return { notes, tokens, budget, skipped };
}

export function mostUsefulFirst(notes: readonly Note[]): Note[] {
  const priorOf = (note: Note) => note.usefulness ?? note.confidence ?? 0;
  return [...notes].sort((a, b) => priorOf(b) - priorOf(a));
}

function renderInjection(layers: readonly LayerBootstrap[]): string {
  const sections = layers
    .filter((layer) => layer.selection.notes.length > 0)
    .map((layer) => renderLayer(layer));
  if (sections.length === 0) return "";
  return `# Memory\n\n${sections.join("\n")}`;
}

function renderLayer(layer: LayerBootstrap): string {
  const notes = layer.selection.notes.map((note) => renderNote(note)).join("\n");
  return `## ${layer.name} memory\n\n${notes}`;
}

function renderNote(note: Note): string {
  return `### [[${note.name}]]\n\n${note.body.trim()}\n`;
}
