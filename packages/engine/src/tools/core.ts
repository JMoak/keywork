import { memoryRecallTools } from "../memory/recall-tools.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Tool } from "../tools.ts";
import { bashTool, detectShell } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export interface MemoryRecall {
  store: MemoryStore;
  search: MemorySearch;
  onRecall?: (noteName: string) => void;
}

export function coreTools(
  cwd: string,
  memory?: MemoryRecall,
  onToolOutput?: (chunk: string) => void,
): Tool[] {
  const base = [
    readTool(cwd),
    writeTool(cwd),
    editTool(cwd),
    bashTool(cwd, detectShell(), onToolOutput),
  ];
  if (memory === undefined) return base;
  return [...base, ...memoryRecallTools(memory.store, memory.search, memory.onRecall)];
}
