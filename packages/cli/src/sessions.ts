import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  knownCostNanos,
  type Message,
  messageText,
  parseReference,
  replaySession,
  type SessionEntry,
  SessionStore,
  type SessionTreeNode,
  type Usage,
} from "@keywork/engine";
import type {
  SessionAttachment,
  SessionOverviewItem,
  SessionPort,
  SessionTreePort,
  SessionTreeView,
} from "@keywork/tui";

export interface OpenedSession {
  store: SessionStore;
  seeded: readonly Message[];
}

export interface ResumeRequest {
  continueLatest?: boolean;
  resumeId?: string;
}

export interface SessionSummary {
  id: string;
  file: string;
  title: string;
  createdAt: string;
  modifiedAt: Date;
  messageCount: number;
}

export async function openOrResumeSession(
  dir: string,
  cwd: string,
  request: ResumeRequest = {},
): Promise<OpenedSession> {
  const file = await resumableFile(dir, request);
  if (file !== undefined) {
    const store = await SessionStore.open(file);
    return { store, seeded: store.messages() };
  }
  const store = await SessionStore.create(join(dir, newSessionFileName()), cwd);
  return { store, seeded: [] };
}

export async function listSessions(dir: string): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  for (const name of await sessionFileNames(dir)) {
    const summary = await summarize(join(dir, name));
    if (summary !== undefined) summaries.push(summary);
  }
  return summaries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export type CheckpointTagSource = () => string | undefined;

export interface SessionPortSeams {
  checkpointTag?: CheckpointTagSource;
  onAttach?(store: SessionStore): void;
  onRelease?(sessionId: string): void;
  onChange?(sessionId: string): void;
}

export interface SessionChangeFeed {
  emit(sessionId: string): void;
  subscribe(listener: (sessionId: string) => void): () => void;
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

export function sessionPort(
  dir: string,
  cwd: string,
  seams: CheckpointTagSource | SessionPortSeams = {},
): SessionPort {
  const resolved = typeof seams === "function" ? { checkpointTag: seams } : seams;
  const attach = (store: SessionStore): SessionAttachment => {
    resolved.onAttach?.(store);
    return attachmentOf(store, resolved);
  };
  return {
    async open(id: string): Promise<SessionAttachment | undefined> {
      try {
        const file = await findSessionFile(dir, id);
        return file === undefined ? undefined : attach(await SessionStore.open(file));
      } catch {
        return undefined;
      }
    },
    async create(): Promise<SessionAttachment | undefined> {
      try {
        return attach(await SessionStore.create(join(dir, newSessionFileName()), cwd));
      } catch {
        return undefined;
      }
    },
    release(sessionId: string): void {
      resolved.onRelease?.(sessionId);
    },
  };
}

export function sessionTreePort(dir: string, changes?: SessionChangeFeed): SessionTreePort {
  return {
    async overview(): Promise<SessionOverviewItem[]> {
      const items: SessionOverviewItem[] = [];
      for (const name of await sessionFileNames(dir)) {
        const item = await overviewItem(join(dir, name));
        if (item !== undefined) items.push(item);
      }
      return items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    async load(sessionId: string): Promise<SessionTreeView | undefined> {
      const store = await openById(dir, sessionId);
      if (store === undefined) return undefined;
      const name = store.name();
      return {
        sessionId: store.header.id,
        roots: store.tree(),
        ...(name !== undefined && { name }),
      };
    },
    async setLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void> {
      const store = await openById(dir, sessionId);
      if (store === undefined) throw new Error(`no session matches id ${sessionId}`);
      await store.setLabel(entryId, label);
      changes?.emit(store.header.id);
    },
    async fork(sessionId: string, entryId: string): Promise<string | undefined> {
      const store = await openById(dir, sessionId);
      if (store === undefined) return undefined;
      const clone = await store.clone(join(dir, newSessionFileName()), entryId);
      changes?.emit(store.header.id);
      return clone.header.id;
    },
    ...(changes !== undefined && {
      subscribe: (listener: (sessionId: string) => void) => changes.subscribe(listener),
    }),
  };
}

export async function findSessionFile(dir: string, idPrefix: string): Promise<string | undefined> {
  for (const summary of await listSessions(dir)) {
    if (summary.id.startsWith(idPrefix)) return summary.file;
  }
  return undefined;
}

export type CleanupConfirm = (question: string) => Promise<boolean>;

export async function sessionsCommand(
  args: readonly string[],
  dir: string,
  print: (line: string) => void = console.log,
  confirmCleanup?: CleanupConfirm,
): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return printList(dir, print, rest.includes("--json"), confirmCleanup);
    case "tree":
      return printTree(dir, rest[0], print);
    case "fork":
      return forkSession(dir, rest[0], rest[1], print);
    default:
      print(`unknown sessions subcommand: ${subcommand} (expected list, tree, or fork)`);
      return 1;
  }
}

export function terminalConfirm(): CleanupConfirm | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (question) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await readline.question(question)).trim().toLowerCase().startsWith("y");
    } finally {
      readline.close();
    }
  };
}

export function newSessionFileName(): string {
  sessionSequence += 1;
  const sequence = String(sessionSequence).padStart(4, "0");
  return `${Date.now()}-${sequence}-${process.pid}.jsonl`;
}

export async function latestSessionFile(dir: string): Promise<string | undefined> {
  const names = await sessionFileNames(dir);
  const last = names.sort().at(-1);
  return last === undefined ? undefined : join(dir, last);
}

let sessionSequence = 0;

async function openById(dir: string, idPrefix: string): Promise<SessionStore | undefined> {
  try {
    const file = await findSessionFile(dir, idPrefix);
    return file === undefined ? undefined : await SessionStore.open(file);
  } catch {
    return undefined;
  }
}

export function attachmentOf(
  store: SessionStore,
  seams: Pick<SessionPortSeams, "checkpointTag" | "onChange"> = {},
): SessionAttachment {
  const name = store.name();
  const selection = store.modelSelection();
  const finishedTurnUsage: Usage[] = [];
  return {
    id: store.header.id,
    ...(name !== undefined && { name }),
    ...(selection !== undefined && {
      modelReference: `${selection.provider}/${selection.modelId}`,
    }),
    history: store.messages(),
    replay: (bus) => {
      replaySession(store, bus);
      bus.on("turn.delta", ({ delta, replay }) => {
        if (replay !== true && delta.type === "done") finishedTurnUsage.push(delta.usage);
      });
    },
    append: async (message) => {
      const checkpoint = message.role === "user" ? seams.checkpointTag?.() : undefined;
      const usage = message.role === "assistant" ? finishedTurnUsage.shift() : undefined;
      await store.append(message, usage, checkpoint);
      seams.onChange?.(store.header.id);
    },
    rename: async (title) => {
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
  };
}

async function resumableFile(dir: string, request: ResumeRequest): Promise<string | undefined> {
  if (request.resumeId !== undefined) {
    const file = await findSessionFile(dir, request.resumeId);
    if (file === undefined) throw new Error(`no session matches id ${request.resumeId}`);
    return file;
  }
  return request.continueLatest === true ? latestSessionFile(dir) : undefined;
}

async function overviewItem(file: string): Promise<SessionOverviewItem | undefined> {
  try {
    const store = await SessionStore.open(file);
    const stats = store.stats();
    if (stats.entries === 0) return undefined;
    const costNanos = knownCostNanos(stats.cost);
    return {
      id: store.header.id,
      title: store.name() ?? firstUserText(store) ?? "(untitled session)",
      modifiedAt: Date.parse(stats.lastActivityAt),
      entryCount: stats.entries,
      branchCount: stats.branchPoints,
      labelCount: stats.labels,
      ...(costNanos !== undefined && { costNanos }),
    };
  } catch {
    return undefined;
  }
}

async function summarize(file: string): Promise<SessionSummary | undefined> {
  try {
    const store = await SessionStore.open(file);
    const stats = store.stats();
    return {
      id: store.header.id,
      file,
      title: store.name() ?? firstUserText(store) ?? "(empty session)",
      createdAt: store.header.timestamp,
      modifiedAt: (await stat(file)).mtime,
      messageCount: stats.messages,
    };
  } catch {
    return undefined;
  }
}

function firstUserText(store: SessionStore): string | undefined {
  for (const entry of store.entries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = messageText(entry.message).trim();
    if (text !== "") return excerpt(text, 60);
  }
  return undefined;
}

async function printList(
  dir: string,
  print: (line: string) => void,
  json: boolean,
  confirmCleanup?: CleanupConfirm,
): Promise<number> {
  const sessions = await listSessions(dir);
  if (json) {
    print(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (sessions.length === 0) {
    print("no sessions yet");
    return 0;
  }
  for (const session of sessions) {
    const stamp = session.modifiedAt.toISOString().slice(0, 16).replace("T", " ");
    const count = String(session.messageCount).padStart(3);
    print(`${session.id.slice(0, 8)}  ${stamp}  ${count} msgs  ${session.title}`);
  }
  if (confirmCleanup !== undefined) await offerEmptySessionCleanup(dir, print, confirmCleanup);
  return 0;
}

async function offerEmptySessionCleanup(
  dir: string,
  print: (line: string) => void,
  confirm: CleanupConfirm,
): Promise<void> {
  const empties = await emptySessionFiles(dir);
  if (empties.length === 0) return;
  const noun = empties.length === 1 ? "file" : "files";
  print(`found ${empties.length} empty session ${noun} (just a header, never used)`);
  if (!(await confirm(`delete ${empties.length === 1 ? "it" : "them"} now? [y/N] `))) return;
  for (const file of empties) await unlink(file);
  print(`removed ${empties.length} empty session ${noun}`);
}

async function emptySessionFiles(dir: string): Promise<string[]> {
  const empties: string[] = [];
  for (const name of await sessionFileNames(dir)) {
    const file = join(dir, name);
    try {
      if ((await SessionStore.open(file)).entries().length === 0) empties.push(file);
    } catch {}
  }
  return empties;
}

async function printTree(
  dir: string,
  idPrefix: string | undefined,
  print: (line: string) => void,
): Promise<number> {
  const store = await openByPrefix(dir, idPrefix, print);
  if (store === undefined) return 1;
  print(`session ${store.header.id.slice(0, 8)} · ${store.name() ?? store.file}`);
  for (const root of store.tree()) printNode(root, "", print);
  return 0;
}

function printNode(node: SessionTreeNode, indent: string, print: (line: string) => void): void {
  const marker = node.onActivePath ? "●" : "○";
  const label = node.label === undefined ? "" : `  [${node.label}]`;
  print(`${indent}${marker} ${node.entry.id.slice(0, 8)} ${describeEntry(node.entry)}${label}`);
  for (const child of node.children) {
    printNode(child, node.children.length > 1 ? `${indent}  ` : indent, print);
  }
}

function describeEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return `${entry.message.role}: ${excerpt(messageText(entry.message), 48)}`;
    case "compaction":
      return `compaction (${entry.tokensBefore} tokens summarized)`;
    case "branch_summary":
      return `branch summary: ${excerpt(entry.summary, 40)}`;
    case "label":
      return `label ${entry.label ?? "(cleared)"} → ${entry.targetId.slice(0, 8)}`;
    case "session_info":
      return `named "${entry.name ?? ""}"`;
    default:
      return entry.type;
  }
}

async function forkSession(
  dir: string,
  idPrefix: string | undefined,
  ref: string | undefined,
  print: (line: string) => void,
): Promise<number> {
  const store = await openByPrefix(dir, idPrefix, print);
  if (store === undefined) return 1;
  const fromId = ref === undefined ? undefined : resolveRef(store, ref);
  if (ref !== undefined && fromId === undefined) {
    print(`no entry or label matches ${ref}`);
    return 1;
  }
  const clone = await store.clone(join(dir, newSessionFileName()), fromId);
  print(`forked → ${clone.header.id.slice(0, 8)} (${clone.file})`);
  print(`resume it with: keywork chat --resume ${clone.header.id.slice(0, 8)}`);
  return 0;
}

function resolveRef(store: SessionStore, ref: string): string | undefined {
  const labeled = store.entryForLabel(ref);
  if (labeled !== undefined) return labeled.id;
  return store.entries().find((entry) => entry.id.startsWith(ref))?.id;
}

async function openByPrefix(
  dir: string,
  idPrefix: string | undefined,
  print: (line: string) => void,
): Promise<SessionStore | undefined> {
  const file =
    idPrefix === undefined ? await latestSessionFile(dir) : await findSessionFile(dir, idPrefix);
  if (file === undefined) {
    print(idPrefix === undefined ? "no sessions yet" : `no session matches id ${idPrefix}`);
    return undefined;
  }
  return SessionStore.open(file);
}

function excerpt(text: string, limit: number): string {
  const flat = text.replaceAll("\n", " ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function sessionFileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
}
