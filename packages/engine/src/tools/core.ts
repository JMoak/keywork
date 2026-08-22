import { memoryRecallTools } from "../memory/recall-tools.ts";
import type { MemorySearcher } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Tool } from "../tools.ts";
import { bashTool, detectShell } from "./bash.ts";
import type { ToolScope } from "./confine.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { persistentBashTool, type ShellSession } from "./shell-session.ts";
import { writeTool } from "./write.ts";

export interface MemoryRecall {
  store: MemoryStore;
  search: MemorySearcher;
  onRecall?: (noteName: string) => void;
}

export interface CoreToolOptions {
  memory?: MemoryRecall | undefined;
  shell?: ShellSession | undefined;
  onToolOutput?: ((chunk: string) => void) | undefined;
  onFileSaved?: ((path: string) => void) | undefined;
}

export function coreTools(scope: ToolScope, options: CoreToolOptions = {}): Tool[] {
  const { memory, shell, onToolOutput, onFileSaved } = options;
  const base = [
    readTool(scope),
    writeTool(scope, onFileSaved),
    editTool(scope, onFileSaved),
    shell === undefined
      ? bashTool(scope.cwd, detectShell(), onToolOutput)
      : persistentBashTool(shell, onToolOutput),
  ];
  if (memory === undefined) return base;
  return [...base, ...memoryRecallTools(memory.store, memory.search, memory.onRecall)];
}
