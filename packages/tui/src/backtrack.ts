import type { MessageEntry, SessionEntry, SessionTreeNode } from "@keywork/engine";

export interface PromptAnchor {
  id: string;
  parentId: string | null;
  checkpoint: string | undefined;
}

export function promptAnchor(
  roots: readonly SessionTreeNode[],
  promptId: string,
): PromptAnchor | undefined {
  const prompt = activePath(roots)
    .filter(isUserPrompt)
    .find((entry) => entry.id === promptId);
  if (prompt === undefined) return undefined;
  return { id: prompt.id, parentId: prompt.parentId, checkpoint: prompt.checkpoint };
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

function isUserPrompt(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}
