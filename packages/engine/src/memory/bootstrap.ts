import type { BootstrapSelection, MemoryStore, Note } from "./store.ts";

export interface BootstrapLayer {
  name: string;
  store: MemoryStore;
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
