import { join } from "node:path";
import {
  childDirFor,
  type EffortLevel,
  isEffortLevel,
  type MessageEntry,
  parseReference,
  replaySession,
  type SessionEntry,
  SessionStore,
  type TurnTrees,
  type Usage,
} from "@keywork/engine";
import type {
  ForgetTarget,
  ReplayedSummary,
  RewoundPrompt,
  SessionAttachment,
  SessionOverviewItem,
  SessionPort,
  SessionRemoval,
  SessionTreePort,
  SessionTreeView,
  ThinkingSwitch,
} from "@keywork/tui";
import { heldGrantsOf, recordHeldGrants } from "./grants-journal.ts";
import {
  discardTrashed,
  forkOrigin,
  listTrash,
  purgeTrash,
  removeSession,
  restoreSession,
} from "./lifecycle.ts";
import { journaledRewind, stagedRewindOf } from "./rewind-journal.ts";
import {
  findSession,
  newSessionFileName,
  type SessionSummary,
  scanSessions,
  summarize,
} from "./store.ts";
import { freezeTurn } from "./turn-journal.ts";
import { firstCheckpointFrom, turnLedger } from "./turns.ts";

export interface SessionPortSeams {
  checkpointTag?(): string | undefined;
  onAttach?(store: SessionStore): void;
  onRelease?(sessionId: string): void;
  onChange?(sessionId: string): void;
  onListen?(sessionId: string, stop: () => void): void;
  onArcBound?(sessionId: string, arc: string | undefined): void;
  turnTrees?: TurnTrees | undefined;
}

export interface SessionChangeFeed {
  emit(sessionId: string): void;
  subscribe(listener: (sessionId: string) => void): () => void;
}

export function sessionPort(dir: string, cwd: string, seams: SessionPortSeams = {}): SessionPort {
  const listeners = new Map<string, Set<() => void>>();
  const attach = (store: SessionStore): SessionAttachment => {
    seams.onAttach?.(store);
    return attachmentOf(store, {
      ...seams,
      onListen: (sessionId, stop) => {
        const stops = listeners.get(sessionId) ?? new Set();
        stops.add(stop);
        listeners.set(sessionId, stops);
        seams.onListen?.(sessionId, stop);
      },
    });
  };
  return {
    async open(id: string): Promise<SessionAttachment | undefined> {
      const store = await findSession(dir, id);
      return store === undefined ? undefined : attach(store);
    },
    async create(): Promise<SessionAttachment> {
      return attach(await SessionStore.create(join(dir, newSessionFileName()), cwd));
    },
    release(sessionId: string): void {
      for (const stop of listeners.get(sessionId) ?? []) stop();
      listeners.delete(sessionId);
      seams.onRelease?.(sessionId);
    },
  };
}

export function sessionTreePort(dir: string, changes?: SessionChangeFeed): SessionTreePort {
  const openOrFail = async (sessionId: string): Promise<SessionStore> => {
    const store = await findSession(dir, sessionId);
    if (store === undefined) throw new Error(`no session matches id ${sessionId}`);
    return store;
  };
  return {
    async overview(): Promise<SessionOverviewItem[]> {
      const families = await Promise.all((await usedStores(dir)).map(familyItems));
      return families.flat().sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    async load(sessionId: string): Promise<SessionTreeView | undefined> {
      const store = await findSession(dir, sessionId);
      if (store === undefined) return undefined;
      const name = store.name();
      const forkedFrom = await forkOrigin(dir, store.header.parentSession);
      return {
        sessionId: store.header.id,
        roots: store.tree(),
        ...(name !== undefined && { name }),
        ...(forkedFrom !== undefined && { forkedFrom }),
      };
    },
    async setLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void> {
      const store = await openOrFail(sessionId);
      await store.setLabel(entryId, label);
      changes?.emit(store.header.id);
    },
    async fork(sessionId: string, entryId: string): Promise<string | undefined> {
      const store = await findSession(dir, sessionId);
      if (store === undefined) return undefined;
      const clone = await store.clone(join(dir, newSessionFileName()), entryId);
      changes?.emit(store.header.id);
      return clone.header.id;
    },
    async remove(sessionId: string): Promise<SessionRemoval> {
      const removed = await removeSession(dir, sessionId);
      if (removed === undefined) return "missing";
      changes?.emit(removed.id);
      return "removed";
    },
    async trash(): Promise<SessionOverviewItem[]> {
      const { sessions } = await listTrash(dir);
      return sessions.map(overviewItem);
    },
    async restore(sessionId: string): Promise<SessionOverviewItem | undefined> {
      const store = await restoreSession(dir, sessionId);
      if (store === undefined) return undefined;
      changes?.emit(store.header.id);
      return overviewItem(await summarize(store));
    },
    async discard(sessionId: string): Promise<boolean> {
      return (await discardTrashed(dir, sessionId)) !== undefined;
    },
    purgeTrash: () => purgeTrash(dir),
    ...(changes !== undefined && {
      subscribe: (listener: (sessionId: string) => void) => changes.subscribe(listener),
    }),
  };
}

export function sessionChangeFeed(): SessionChangeFeed {
  const listeners = new Set<(sessionId: string) => void>();
  return {
    emit: (sessionId) => {
      for (const listener of [...listeners]) listener(sessionId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function attachmentOf(
  store: SessionStore,
  seams: Pick<
    SessionPortSeams,
    "checkpointTag" | "onChange" | "onListen" | "onArcBound" | "turnTrees"
  > = {},
): SessionAttachment {
  const ledger = turnLedger(store, seams.turnTrees);
  const name = store.name();
  const selection = store.modelSelection();
  const thinking = thinkingSwitchOf(store.thinkingLevel());
  const effort = effortOf(store.effort());
  const finishedTurnUsage: Usage[] = [];
  return {
    id: store.header.id,
    ...(name !== undefined && { name }),
    ...(selection !== undefined && {
      modelReference: `${selection.provider}/${selection.modelId}`,
    }),
    ...(thinking !== undefined && { thinking }),
    ...(effort !== undefined && { effort }),
    get arc() {
      return store.arcBinding();
    },
    get bot() {
      return store.botBinding();
    },
    history: store.messages(),
    replay: (bus) => {
      replaySession(store, bus);
      const stop = bus.on("turn.delta", ({ delta, replay }) => {
        if (replay !== true && delta.type === "done") finishedTurnUsage.push(delta.usage);
      });
      seams.onListen?.(store.header.id, stop);
    },
    append: async (message) => {
      const checkpoint = message.role === "user" ? seams.checkpointTag?.() : undefined;
      const usage = message.role === "assistant" ? finishedTurnUsage.shift() : undefined;
      const entry = await store.append(message, usage, checkpoint);
      if (message.role === "user") ledger.settled(entry.id);
      seams.onChange?.(store.header.id);
      return { entryId: entry.id };
    },
    openTurn: async (prompt) => {
      const entry = await store.append(prompt);
      seams.onChange?.(store.header.id);
      return { entryId: entry.id };
    },
    settleTurn: async (promptId) => {
      await freezeTurn(store, promptId, seams.checkpointTag?.(), seams.turnTrees);
      seams.onChange?.(store.header.id);
    },
    quiet: store.quiet(),
    summaries: replayedSummaries(store),
    recordQuiet: async (on) => {
      if (store.quiet() === on) return;
      await store.appendQuietChange(on);
      seams.onChange?.(store.header.id);
    },
    turns: () => ledger.read(),
    pinTitle: async (title) => {
      await store.setName(title, true);
      seams.onChange?.(store.header.id);
    },
    rename: async (title) => {
      if (store.titlePinned()) return;
      await store.setName(title);
      seams.onChange?.(store.header.id);
    },
    recordModel: async (reference) => {
      const current = store.modelSelection();
      const parsed = parseReference(reference);
      if (parsed === undefined) return;
      if (current?.provider === parsed.provider && current.modelId === parsed.model) return;
      await store.appendModelChange(parsed.provider, parsed.model);
      seams.onChange?.(store.header.id);
    },
    recordThinking: async (level) => {
      if (thinkingSwitchOf(store.thinkingLevel()) === level) return;
      await store.appendThinkingLevelChange(level);
      seams.onChange?.(store.header.id);
    },
    recordEffort: async (level) => {
      if (store.effort() === level) return;
      await store.appendEffortChange(level);
      seams.onChange?.(store.header.id);
    },
    bindArc: async (slug) => {
      if (store.arcBinding() === slug) return;
      await store.appendArcBinding(slug);
      seams.onArcBound?.(store.header.id, slug);
      seams.onChange?.(store.header.id);
    },
    bindBot: async (name) => {
      if (store.botBinding() === name) return;
      await store.appendBotBinding(name);
      seams.onChange?.(store.header.id);
    },
    rewindBefore: (promptId) => {
      const from = store.leafId();
      const rewound = rewindBefore(store, promptId);
      return (
        rewound && journaledRewind(store, rewound, from, () => seams.onChange?.(store.header.id))
      );
    },
    ...journaledState(store, () => seams.onChange?.(store.header.id)),
    recordGrants: async (rules) => {
      await recordHeldGrants(store, rules);
      seams.onChange?.(store.header.id);
    },
    forget: async (target, replacement) => {
      const entry = contextEditTarget(store, target);
      if (entry === undefined) return undefined;
      await store.appendContextEdit(entry.id, replacement);
      seams.onChange?.(store.header.id);
      return store.messages();
    },
  };
}

function contextEditTarget(store: SessionStore, target: ForgetTarget): MessageEntry | undefined {
  const onPath = store.activePath().filter(isMessageEntry);
  if (target.kind === "prompt") {
    return onPath.find((entry) => entry.id === target.promptId && entry.message.role === "user");
  }
  return onPath.find(
    (entry) =>
      entry.message.role === "tool" &&
      entry.message.parts.some(
        (part) => part.type === "tool-result" && part.callId === target.callId,
      ),
  );
}

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message";
}

export function rewindBefore(store: SessionStore, promptId: string): RewoundPrompt | undefined {
  const prompt = store.entry(promptId);
  if (prompt?.type !== "message" || prompt.message.role !== "user") return undefined;
  const leaf = store.leafId();
  const checkpoint = firstCheckpointFrom(store.activePath(), prompt);
  moveLeaf(store, prompt.parentId);
  return {
    checkpoint,
    history: store.messages(),
    restore: () => {
      moveLeaf(store, leaf);
      return store.messages();
    },
  };
}

export function moveLeaf(store: SessionStore, entryId: string | null): void {
  if (entryId === null) store.resetLeaf();
  else store.branch(entryId);
}

function journaledState(
  store: SessionStore,
  changed: () => void,
): Pick<SessionAttachment, "stagedRewind" | "grants"> {
  const stagedRewind = stagedRewindOf(store, changed);
  const grants = heldGrantsOf(store);
  return {
    ...(stagedRewind !== undefined && { stagedRewind }),
    ...(grants !== undefined && { grants }),
  };
}

function replayedSummaries(store: SessionStore): ReplayedSummary[] {
  return store
    .contextEntries()
    .flatMap((entry) =>
      entry.type === "compaction" || entry.type === "branch_summary"
        ? [{ text: entry.summary, kind: entry.type }]
        : [],
    );
}

async function usedStores(dir: string): Promise<SessionStore[]> {
  const { stores } = await scanSessions(dir);
  return stores.filter((store) => store.stats().entries > 0);
}

async function familyItems(parent: SessionStore): Promise<SessionOverviewItem[]> {
  const children = await usedStores(childDirFor(parent.file));
  const parentId = parent.header.id;
  return Promise.all([
    summarize(parent).then(overviewItem),
    ...children.map(async (child) => ({ ...overviewItem(await summarize(child)), parentId })),
  ]);
}

export async function boundSessionCounts(dir: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const { stores } = await scanSessions(dir);
  for (const store of stores) {
    const arc = store.arcBinding();
    if (arc !== undefined) counts.set(arc, (counts.get(arc) ?? 0) + 1);
  }
  return counts;
}

function thinkingSwitchOf(level: string | undefined): ThinkingSwitch | undefined {
  return level === "on" || level === "off" ? level : undefined;
}

function effortOf(level: string | undefined): EffortLevel | undefined {
  return level !== undefined && isEffortLevel(level) ? level : undefined;
}

function overviewItem(summary: SessionSummary): SessionOverviewItem {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: Date.parse(summary.createdAt),
    modifiedAt: Date.parse(summary.lastActivityAt),
    entryCount: summary.entryCount,
    branchCount: summary.branchCount,
    labelCount: summary.labelCount,
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
    ...(summary.bot !== undefined && { bot: summary.bot }),
  };
}
