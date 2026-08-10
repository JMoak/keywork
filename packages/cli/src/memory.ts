import { join } from "node:path";
import {
  bootstrapMemory,
  estimateContextTokens,
  Gardener,
  type MemoryFlush,
  type MemoryRecall,
  MemorySearch,
  MemoryStore,
  type Message,
  type Note,
  ReviewInbox,
  type ReviewItem,
  type SessionStore,
  type StagedItem,
} from "@keywork/engine";
import { resolveVaultPath } from "@keywork/shared";
import type {
  CuringStage,
  InboxItemView,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryPanePort,
} from "@keywork/tui";

export interface WorkspaceMemory {
  store: MemoryStore;
  search: MemorySearch;
  inbox: ReviewInbox;
  gardener: Gardener;
}

export const memoryBootstrapBudget = 4096;
export const assumedContextWindow = 200_000;

export function openWorkspaceMemory(cwd: string, trusted: boolean): WorkspaceMemory | undefined {
  const vaultRoot = resolveVaultPath(cwd);
  if (vaultRoot === undefined) return undefined;
  const store = new MemoryStore({ vaultRoot, trusted });
  const inbox = new ReviewInbox({ filePath: join(vaultRoot, ".staging", "inbox.json") });
  return {
    store,
    search: new MemorySearch(store),
    inbox,
    gardener: new Gardener({ store, inbox }),
  };
}

export function memoryRecall(
  memory: WorkspaceMemory | undefined,
  sessionId?: string,
): MemoryRecall | undefined {
  if (memory === undefined) return undefined;
  return {
    store: memory.store,
    search: memory.search,
    ...(sessionId !== undefined && {
      onRecall: (noteName: string) => memory.gardener.recordRecall(noteName, sessionId),
    }),
  };
}

export async function bootstrapInjection(memory: WorkspaceMemory | undefined): Promise<string> {
  if (memory === undefined) return "";
  const injection = await bootstrapMemory([
    { name: "workspace", store: memory.store, budget: memoryBootstrapBudget },
  ]);
  return injection.text;
}

export function withMemoryPrompt(systemPrompt: string, injection: string): string {
  return injection === "" ? systemPrompt : `${systemPrompt}\n\n${injection}`;
}

export async function flushAfterTurn(
  flush: MemoryFlush | undefined,
  store: SessionStore,
  history: readonly Message[],
  contextWindow: number = assumedContextWindow,
): Promise<Message[]> {
  if (flush === undefined) return [];
  try {
    const outcome = await flush.maybeFlush(history, estimateContextTokens(store), contextWindow);
    for (const message of outcome.messages) await store.append(message);
    return outcome.messages;
  } catch {
    return [];
  }
}

export async function sweepOnClose(memory: WorkspaceMemory | undefined): Promise<void> {
  if (memory === undefined) return;
  try {
    await memory.gardener.sweep();
  } catch {}
}

export function memoryPanePort(memory: WorkspaceMemory): MemoryPanePort {
  const { store, inbox } = memory;
  return {
    load: () => loadInputs(store, inbox),
    approve: (id) => actOn(store, inbox, id, "approve"),
    discard: (id) => actOn(store, inbox, id, "discard"),
  };
}

const stagedIdPrefix = "staged:";
const reviewIdPrefix = "review:";

async function loadInputs(store: MemoryStore, inbox: ReviewInbox): Promise<MemoryPaneInputs> {
  if (!store.trusted) return { scopes: [], notes: [], inbox: [], recalls: [] };
  const notes = (await store.listNotes()).map(noteView);
  const staged = (await store.listStaged()).map(stagedView);
  const reviews = (await inbox.list()).map(reviewView);
  return { scopes: ["workspace"], notes, inbox: [...staged, ...reviews], recalls: [] };
}

async function actOn(
  store: MemoryStore,
  inbox: ReviewInbox,
  id: string,
  action: "approve" | "discard",
): Promise<void> {
  if (id.startsWith(stagedIdPrefix)) {
    const stagedId = id.slice(stagedIdPrefix.length);
    if (action === "approve") await store.approve(stagedId);
    else await store.discard(stagedId);
    return;
  }
  await inbox.resolve(id.startsWith(reviewIdPrefix) ? id.slice(reviewIdPrefix.length) : id);
}

function noteView(note: Note): MemoryNoteView {
  return {
    name: note.name,
    title: note.title,
    scope: "workspace",
    provenance: note.provenance,
    curing: curingStage(note),
    links: note.links,
    aliases: note.aliases,
    ...(note.supersededBy !== undefined && { supersededBy: note.supersededBy }),
  };
}

function curingStage(note: Note): CuringStage {
  if (note.provenance !== "agent") return 3;
  return note.usefulness === undefined ? 1 : 3;
}

function stagedView(item: StagedItem): InboxItemView {
  return {
    id: `${stagedIdPrefix}${item.id}`,
    kind: "staged",
    title: item.target,
    provenance: "untrusted",
    created: item.created,
    detail: item.kind,
  };
}

function reviewView(item: ReviewItem): InboxItemView {
  const base = { id: `${reviewIdPrefix}${item.id}`, created: item.created } as const;
  switch (item.kind) {
    case "borderline-promotion":
      return {
        ...base,
        kind: "promotion",
        title: item.title,
        provenance: "agent",
        detail: `from ${item.source}`,
      };
    case "contradiction":
      return {
        ...base,
        kind: "contradiction",
        title: `${item.a} vs ${item.b}`,
        provenance: worseProvenance(item.aProvenance, item.bProvenance),
      };
    case "merge-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `merge ${item.retire} into ${item.keep}`,
        provenance: "agent",
      };
    case "supersession-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `${item.winner} supersedes ${item.loser}`,
        provenance: "agent",
      };
    case "link-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `link ${item.note} → ${item.target}`,
        provenance: "agent",
      };
  }
}

function worseProvenance(a: Note["provenance"], b: Note["provenance"]): Note["provenance"] {
  const order: Note["provenance"][] = ["user", "agent", "untrusted"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
