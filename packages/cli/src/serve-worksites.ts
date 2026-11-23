import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureHandle,
  type CreatureWorksites,
  changedFileOf,
  childDirSuffix,
  creatureTagOf,
  isMissingFileError,
  type JournalledConversation,
  type SessionEntry,
  type SessionStore,
  type WorkingConversation,
  type WorksiteHistory,
} from "@keywork/engine";
import type { EventLog, WirePayload } from "@keywork/server";
import type { CreatureSessionFacts } from "./serve-ledger.ts";
import { scanSessions } from "./sessions/store.ts";

export interface WorksiteSessionFacts extends CreatureSessionFacts {
  visitor?: string | undefined;
}

export interface WorksiteSources {
  sessionDir: string;
  creatures(): Promise<readonly string[]>;
  visitingCreatureOf(entries: readonly SessionEntry[]): CreatureHandle | undefined;
}

export function followWorksites(
  log: Pick<EventLog, "subscribe">,
  worksites: Pick<CreatureWorksites, "began" | "changedFile">,
  sessionOf: (id: string) => WorksiteSessionFacts | undefined,
): () => void {
  const underway = new Map<string, FileChangeUnderway>();
  return log.subscribe(({ sessionId, type, payload }) => {
    if (replayed(payload)) return;
    switch (type) {
      case "turn.started": {
        const facts = sessionOf(sessionId);
        if (facts?.parent === null) worksites.began(conversationOf(sessionId, facts));
        return;
      }
      case "tool.started": {
        const { call } = payload as WirePayload<"tool.started">;
        const path = changedFileOf(call.name, call.arguments);
        const facts = path === undefined ? undefined : sessionOf(sessionId);
        if (path === undefined || facts === undefined) return;
        const conversation = conversationOf(sessionId, facts);
        underway.set(callKeyOf(sessionId, call.callId), { conversation, path });
        return;
      }
      case "tool.finished": {
        const { callId, isError } = payload as WirePayload<"tool.finished">;
        const key = callKeyOf(sessionId, callId);
        const change = underway.get(key);
        underway.delete(key);
        if (change !== undefined && !isError)
          worksites.changedFile(change.conversation, change.path);
        return;
      }
    }
  });
}

export async function worksiteHistory(sources: WorksiteSources): Promise<WorksiteHistory> {
  const creatures = new Set(await sources.creatures());
  const stores = await everySessionIn(sources.sessionDir);
  return { conversations: journalledConversations(stores, creatures, sources.visitingCreatureOf) };
}

interface FileChangeUnderway {
  conversation: WorkingConversation;
  path: string;
}

function conversationOf(sessionId: string, facts: WorksiteSessionFacts): WorkingConversation {
  return {
    id: facts.parent ?? sessionId,
    creature: facts.creature,
    root: facts.directory,
    ...(facts.visitor !== undefined && { visitor: facts.visitor }),
  };
}

function callKeyOf(sessionId: string, callId: string): string {
  return `${sessionId} ${callId}`;
}

function replayed(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { replay?: unknown }).replay === true
  );
}

function journalledConversations(
  stores: readonly SessionStore[],
  creatures: ReadonlySet<string>,
  visitingCreatureOf: WorksiteSources["visitingCreatureOf"],
): JournalledConversation[] {
  const byId = new Map(stores.map((store) => [store.header.id, store]));
  return stores.flatMap((store) => {
    const owner = ownerOf(store, byId);
    const journalled = { id: owner.header.id, root: store.header.cwd, entries: store.entries() };
    const tag = creatureTagOf(store.entries()) ?? creatureTagOf(owner.entries());
    if (tag !== undefined) {
      return creatures.has(tag.creature) ? [{ ...journalled, creature: tag.creature }] : [];
    }
    const visiting = visitingCreatureOf(store.entries()) ?? visitingCreatureOf(owner.entries());
    if (visiting === undefined) return [];
    return [{ ...journalled, creature: visiting.slug, visitor: visiting.workspace }];
  });
}

function ownerOf(store: SessionStore, byId: ReadonlyMap<string, SessionStore>): SessionStore {
  const seen = new Set<string>();
  let owner = store;
  for (;;) {
    seen.add(owner.header.id);
    const parent = byId.get(owner.header.spawnedBy?.sessionId ?? "");
    if (parent === undefined || seen.has(parent.header.id)) return owner;
    owner = parent;
  }
}

async function everySessionIn(dir: string): Promise<SessionStore[]> {
  const { stores } = await scanSessions(dir);
  const children = await childDirsIn(dir);
  const nested = await Promise.all(children.map((child) => everySessionIn(join(dir, child))));
  return [...stores, ...nested.flat()];
}

async function childDirsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(childDirSuffix));
  } catch (cause) {
    if (isMissingFileError(cause)) return [];
    throw cause;
  }
}
