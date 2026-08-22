import { memoryRecallTools } from "../memory/recall-tools.ts";
import type { MemorySearcher } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Tool } from "../tools.ts";
import { bashTool, detectShell } from "./bash.ts";
import { scopeCwd, type ToolScope } from "./confine.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { persistentBashTool, type ShellSession } from "./shell-session.ts";
import { writeTool } from "./write.ts";

export interface MemoryRecall {
  store: MemoryStore;
  search: MemorySearcher;
  onRecall?: (noteName: string) => void;
}

export interface CoreToolTaps {
  onToolOutput?: ((chunk: string) => void) | undefined;
  onFileSaved?: ((path: string) => void) | undefined;
}

export function coreTools(
  scope: string | ToolScope,
  memory?: MemoryRecall,
  taps: CoreToolTaps | ((chunk: string) => void) = {},
  shell?: ShellSession,
): Tool[] {
  const { onToolOutput, onFileSaved } = typeof taps === "function" ? { onToolOutput: taps } : taps;
  const base = [
    readTool(scope),
    writeTool(scope, onFileSaved),
    editTool(scope, onFileSaved),
    shell === undefined
      ? bashTool(scopeCwd(scope), detectShell(), onToolOutput)
      : persistentBashTool(shell, onToolOutput),
  ];
  if (memory === undefined) return base;
  return [...base, ...memoryRecallTools(memory.store, memory.search, memory.onRecall)];
}
