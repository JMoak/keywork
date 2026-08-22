import { join } from "node:path";
import {
  AskGateLedger,
  bootstrapMemory,
  type EmbeddingsPort,
  Gardener,
  type MemoryRecall,
  MemorySearch,
  MemoryStore,
  type Note,
  type Provenance,
  type RetrievalSource,
  type StagedItem,
  type StagedWrite,
} from "@keywork/engine";
import { resolveVaultPath, toError } from "@keywork/shared";
import type {
  CuringStage,
  InboxItemView,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryPanePort,
} from "@keywork/tui";
import type { ArcService } from "./arcs.ts";

export interface WorkspaceMemory {
  store: MemoryStore;
  search: MemorySearch;
  gardener: Gardener;
  askGate: AskGateLedger;
  embeddings?: EmbeddingsPort;
}

export const memoryBootstrapBudget = 4096;

export function openWorkspaceMemory(
  cwd: string,
  trusted: boolean,
  slug?: string,
): WorkspaceMemory | undefined {
  const vaultRoot = resolveVaultPath(cwd, slug);
  if (vaultRoot === undefined) return undefined;
  const store = new MemoryStore({ vaultRoot, trusted });
  return {
    store,
    search: new MemorySearch(store),
    gardener: new Gardener({ store }),
    askGate: trusted
      ? new AskGateLedger({ filePath: join(vaultRoot, ".staging", "ask-gate.json") })
      : new AskGateLedger(),
  };
}

export type SessionKey = string | (() => string | undefined);

export function memoryRecall(
  memory: WorkspaceMemory | undefined,
  sessionId?: SessionKey,
  onRetrieval?: (disclosure: string) => void,
  arcs?: ArcService,
): MemoryRecall | undefined {
  if (memory === undefined) return undefined;
  const workspace = recallSearch(memory, onRetrieval);
  const search =
    arcs === undefined || sessionId === undefined
      ? workspace
      : arcs.searcher(workspace, sessionId, memory.embeddings);
  return {
    store: memory.store,
    search,
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

export async function sweepOnClose(memory: WorkspaceMemory | undefined): Promise<void> {
  if (memory === undefined) return;
  const failures: Error[] = [];
  const attempt = (work: () => Promise<unknown>): Promise<void> =>
    work().then(
      () => undefined,
      (cause: unknown) => {
        failures.push(toError(cause));
      },
    );
  await attempt(() => memory.gardener.sweep());
  if (memory.store.trusted) await attempt(() => memory.askGate.proposePreferences(memory.store));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `memory close: ${failures.map((failure) => failure.message).join(" · ")}`,
    );
  }
}

export function memoryPanePort(memory: WorkspaceMemory): MemoryPanePort {
  const { store } = memory;
  return {
    load: () => loadInputs(store),
    approve: async (id) => {
      await store.approve(id);
    },
    discard: (id) => store.discard(id),
  };
}

async function loadInputs(store: MemoryStore): Promise<MemoryPaneInputs> {
  if (!store.trusted) return { scopes: [], notes: [], inbox: [], recalls: [] };
  const notes = (await store.listNotes()).map(noteView);
  const inbox = (await store.listStaged()).map(inboxView);
  return { scopes: ["workspace"], notes, inbox, recalls: [] };
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

function inboxView(item: StagedItem): InboxItemView {
  const base = { id: item.id, created: item.created } as const;
  switch (item.kind) {
    case "note":
    case "daily":
    case "moc":
      return stagedWriteView(item, base);
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
    case "preference-proposal":
      return {
        ...base,
        kind: "proposal",
        title: `allow ${item.toolShape} without asking`,
        provenance: "user",
        detail: `approved ${item.approvals} times in a row`,
      };
  }
}

function stagedWriteView(
  item: StagedWrite,
  base: Pick<InboxItemView, "id" | "created">,
): InboxItemView {
  return {
    ...base,
    kind: "staged",
    title: item.target,
    provenance: "untrusted",
    detail: item.kind,
  };
}

function worseProvenance(a: Provenance, b: Provenance): Provenance {
  const order: Provenance[] = ["user", "agent", "untrusted"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
