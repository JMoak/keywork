import { join } from "node:path";
import {
  bootstrapMemory,
  type EmbeddingsPort,
  estimateContextTokens,
  Gardener,
  type MemoryFlush,
  type MemoryRecall,
  MemorySearch,
  MemoryStore,
  type Message,
  type Note,
  type RetrievalSource,
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
  embeddings?: EmbeddingsPort;
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

export type SessionKey = string | (() => string | undefined);

export function memoryRecall(
  memory: WorkspaceMemory | undefined,
  sessionId?: SessionKey,
  onRetrieval?: (disclosure: string) => void,
): MemoryRecall | undefined {
  if (memory === undefined) return undefined;
  return {
    store: memory.store,
    search: recallSearch(memory, onRetrieval),
    onRecall: recallTap(memory, sessionId),
  };
}

export function retrievalDisclosure(source: RetrievalSource): string | undefined {
  switch (source.kind) {
    case "lexical":
      return undefined;
    case "hybrid":
      return `memory search uses embeddings from ${source.embeddings}`;
    case "lexical-degraded":
      return `memory search fell back to lexical, embeddings from ${source.embeddings} aren't available`;
  }
}

function recallSearch(
  memory: WorkspaceMemory,
  onRetrieval?: (disclosure: string) => void,
): MemorySearch {
  if (onRetrieval === undefined) return memory.search;
  return new MemorySearch(memory.store, memory.embeddings, ({ source }) => {
    const disclosure = retrievalDisclosure(source);
    if (disclosure !== undefined) onRetrieval(disclosure);
  });
}

function recallTap(memory: WorkspaceMemory, sessionId?: SessionKey): (noteName: string) => void {
  const resolveSession = typeof sessionId === "function" ? sessionId : () => sessionId;
  return (noteName) => {
    const id = resolveSession();
    if (id !== undefined) memory.gardener.recordRecall(noteName, id);
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
    case "arc-distillation":
      return {
        ...base,
        kind: "proposal",
        title: `arc ${item.arc}: deliver ${item.note}`,
        provenance: "agent",
        detail: item.eligible ? "eligible" : "below bar",
      };
    case "arc-question":
      return {
        ...base,
        kind: "proposal",
        title: `arc ${item.arc}: triage ${item.note}`,
        provenance: "agent",
      };
  }
}

function worseProvenance(a: Note["provenance"], b: Note["provenance"]): Note["provenance"] {
  const order: Note["provenance"][] = ["user", "agent", "untrusted"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
