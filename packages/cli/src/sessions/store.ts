import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isMissingFileError,
  knownCostNanos,
  type Message,
  messageText,
  SessionStore,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import { excerpt } from "../text.ts";

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
  lastActivityAt: string;
  messageCount: number;
  entryCount: number;
  branchCount: number;
  labelCount: number;
  costNanos?: number;
  arc?: string;
  bot?: string;
}

export interface UnreadableSession {
  file: string;
  reason: string;
}

export interface SessionScan {
  stores: SessionStore[];
  unreadable: UnreadableSession[];
}

export interface SessionListing {
  sessions: SessionSummary[];
  unreadable: UnreadableSession[];
}

export async function openOrResumeSession(
  dir: string,
  cwd: string,
  request: ResumeRequest = {},
): Promise<OpenedSession> {
  const store = await resumableStore(dir, request);
  if (store !== undefined) return { store, seeded: store.messages() };
  return { store: await SessionStore.create(join(dir, newSessionFileName()), cwd), seeded: [] };
}

export async function scanSessions(dir: string): Promise<SessionScan> {
  const scan: SessionScan = { stores: [], unreadable: [] };
  for (const name of await sessionFileNames(dir)) {
    const file = join(dir, name);
    try {
      scan.stores.push(await SessionStore.open(file));
    } catch (cause) {
      scan.unreadable.push({ file, reason: toError(cause).message });
    }
  }
  return scan;
}

export async function listSessions(dir: string): Promise<SessionListing> {
  const { stores, unreadable } = await scanSessions(dir);
  const sessions = await Promise.all(stores.map(summarize));
  return { sessions: sessions.sort(newestFirst), unreadable };
}

export async function findSession(
  dir: string,
  idPrefix: string,
): Promise<SessionStore | undefined> {
  const { stores } = await scanSessions(dir);
  return stores.find((store) => store.header.id.startsWith(idPrefix));
}

export async function latestSessionFile(dir: string): Promise<string | undefined> {
  const last = (await sessionFileNames(dir)).sort().at(-1);
  return last === undefined ? undefined : join(dir, last);
}

export function newSessionFileName(): string {
  sessionSequence += 1;
  const sequence = String(sessionSequence).padStart(4, "0");
  return `${Date.now()}-${sequence}-${process.pid}.jsonl`;
}

export async function summarize(store: SessionStore): Promise<SessionSummary> {
  const stats = store.stats();
  const costNanos = knownCostNanos(stats.cost);
  const arc = store.arcBinding();
  const bot = store.botBinding();
  return {
    id: store.header.id,
    file: store.file,
    title: sessionTitle(store),
    createdAt: store.header.timestamp,
    modifiedAt: (await stat(store.file)).mtime,
    lastActivityAt: stats.lastActivityAt,
    messageCount: stats.messages,
    entryCount: stats.entries,
    branchCount: stats.branchPoints,
    labelCount: stats.labels,
    ...(costNanos !== undefined && { costNanos }),
    ...(arc !== undefined && { arc }),
    ...(bot !== undefined && { bot }),
  };
}

function sessionTitle(store: SessionStore): string {
  return store.name() ?? firstUserText(store) ?? "(untitled session)";
}

let sessionSequence = 0;

async function resumableStore(
  dir: string,
  request: ResumeRequest,
): Promise<SessionStore | undefined> {
  if (request.resumeId !== undefined) {
    const store = await findSession(dir, request.resumeId);
    if (store === undefined) throw new Error(`no session matches id ${request.resumeId}`);
    return store;
  }
  if (request.continueLatest !== true) return undefined;
  const file = await latestSessionFile(dir);
  return file === undefined ? undefined : SessionStore.open(file);
}

async function sessionFileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch (cause) {
    if (isMissingFileError(cause)) return [];
    throw cause;
  }
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.modifiedAt.getTime() - a.modifiedAt.getTime();
}

function firstUserText(store: SessionStore): string | undefined {
  for (const entry of store.entries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = messageText(entry.message).trim();
    if (text !== "") return excerpt(text, 60);
  }
  return undefined;
}
