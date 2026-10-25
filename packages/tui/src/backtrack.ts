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

export function turnEndOf(roots: readonly SessionTreeNode[], promptId: string): string | undefined {
  const path = activePath(roots);
  const at = path.findIndex((entry) => entry.id === promptId && isUserPrompt(entry));
  if (at === -1) return undefined;
  const next = path.slice(at + 1).find(isUserPrompt);
  return next === undefined ? path.at(-1)?.id : (next.parentId ?? undefined);
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
