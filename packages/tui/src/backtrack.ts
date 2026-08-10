import type { SessionEntry, SessionTreeNode } from "@keywork/engine";

export interface PromptAnchor {
  id: string;
  parentId: string | null;
}

export function promptAnchor(
  roots: readonly SessionTreeNode[],
  promptOrdinal: number,
): PromptAnchor | undefined {
  const prompts = activePath(roots).filter(isUserPrompt);
  const entry = prompts[promptOrdinal];
  return entry === undefined ? undefined : { id: entry.id, parentId: entry.parentId };
}

function activePath(roots: readonly SessionTreeNode[]): SessionEntry[] {
  const path: SessionEntry[] = [];
  let level: readonly SessionTreeNode[] = roots;
  for (;;) {
    const node = level.find((candidate) => candidate.onActivePath);
    if (node === undefined) return path;
    path.push(node.entry);
    level = node.children;
  }
}

function isUserPrompt(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}
