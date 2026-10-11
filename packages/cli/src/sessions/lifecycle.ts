import { basename, join } from "node:path";
import { isMissingFileError, SessionStore, SessionTrash } from "@keywork/engine";
import {
  findSession,
  listSessions,
  type SessionListing,
  type SessionSummary,
  summarize,
} from "./store.ts";

export interface ForkOrigin {
  sessionId?: string;
  removed: boolean;
}

export async function removeSession(
  dir: string,
  idPrefix: string,
): Promise<SessionSummary | undefined> {
  const store = await findSession(dir, idPrefix);
  return store === undefined ? undefined : trashStore(dir, store);
}

export async function trashStore(dir: string, store: SessionStore): Promise<SessionSummary> {
  const summary = await summarize(store);
  const file = await new SessionTrash(dir).put(store.file);
  return { ...summary, file };
}

export async function restoreSession(
  dir: string,
  idPrefix: string,
): Promise<SessionStore | undefined> {
  const trashed = await findTrashed(dir, idPrefix);
  if (trashed === undefined) return undefined;
  return SessionStore.open(await new SessionTrash(dir).restore(trashed.file));
}

export function listTrash(dir: string): Promise<SessionListing> {
  return listSessions(new SessionTrash(dir).dir);
}

export function findTrashed(dir: string, idPrefix: string): Promise<SessionStore | undefined> {
  return findSession(new SessionTrash(dir).dir, idPrefix);
}

export async function discardTrashed(
  dir: string,
  idPrefix: string,
): Promise<SessionSummary | undefined> {
  const trashed = await findTrashed(dir, idPrefix);
  if (trashed === undefined) return undefined;
  const summary = await summarize(trashed);
  await new SessionTrash(dir).discard(trashed.file);
  return summary;
}

export function purgeTrash(dir: string): Promise<number> {
  return new SessionTrash(dir).purge();
}

export async function forkOrigin(
  dir: string,
  parent: string | undefined,
): Promise<ForkOrigin | undefined> {
  if (parent === undefined) return undefined;
  const present = await headerIdOf(parent);
  if (present !== undefined) return { sessionId: present, removed: false };
  const trashed = await headerIdOf(join(new SessionTrash(dir).dir, basename(parent)));
  return trashed === undefined ? { removed: true } : { sessionId: trashed, removed: true };
}

export const memoryStaysNote =
  "memory notes it wrote stay · keywork memory forget --session drops them";

async function headerIdOf(file: string): Promise<string | undefined> {
  try {
    return (await SessionStore.open(file)).header.id;
  } catch (cause) {
    if (isMissingFileError(cause)) return undefined;
    throw cause;
  }
}
