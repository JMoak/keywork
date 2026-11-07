import type { ServerKind } from "../capabilities/types.ts";
import { llamaServerAdapter } from "./llama-server/index.ts";
import { ollamaAdapter } from "./ollama/index.ts";
import type { ServerAdapter } from "./types.ts";

export const serverAdapters: readonly ServerAdapter[] = [ollamaAdapter, llamaServerAdapter];

export function adapterFor(kind: ServerKind): ServerAdapter | undefined {
  return serverAdapters.find((adapter) => adapter.deltas.kind === kind);
}
