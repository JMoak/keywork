import { memoryRecallTools } from "../memory/recall-tools.ts";
import type { MemorySearcher } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Tool } from "../tools.ts";
import type { AfterSave } from "./after-save.ts";
import { bashTool, detectShell } from "./bash.ts";
import { reportingChanges, type WorktreeChanges } from "./command-changes.ts";
import type { ToolScope } from "./confine.ts";
import { editTool } from "./edit.ts";
import type { OriginSource } from "./protected-writes.ts";
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
  afterSave?: AfterSave | undefined;
  vault?: MemoryStore | undefined;
  worktree?: WorktreeChanges | undefined;
  origin?: OriginSource | undefined;
}

export function coreTools(scope: ToolScope, options: CoreToolOptions = {}): Tool[] {
  const { memory, shell, onToolOutput, afterSave } = options;
  const vault = options.vault ?? memory?.store;
  const base = [
    readTool(scope),
    writeTool(scope, { afterSave, vault, origin: options.origin }),
    editTool(scope, { afterSave, vault, origin: options.origin }),
    reportingChanges(
      shell === undefined
        ? bashTool(scope.cwd, detectShell(), onToolOutput)
        : persistentBashTool(shell, onToolOutput),
      options.worktree,
    ),
  ];
  if (memory === undefined) return base;
  return [...base, ...memoryRecallTools(memory.store, memory.search, memory.onRecall)];
}
