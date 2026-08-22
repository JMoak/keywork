import { homedir } from "node:os";
import { join } from "node:path";
import { pathKeyedStringStore } from "@keywork/shared";

export interface AnchorMemory {
  recall(cwd: string): string | undefined;
  remember(cwd: string, root: string): void;
}

export function anchorMemoryFile(home: string = homedir()): string {
  return join(home, ".keywork", "anchors.json");
}

export function fileAnchorMemory(file: string = anchorMemoryFile()): AnchorMemory {
  const anchors = pathKeyedStringStore(file);
  return {
    recall: (cwd) => anchors.get(cwd),
    remember: (cwd, root) => anchors.set(cwd, root),
  };
}
