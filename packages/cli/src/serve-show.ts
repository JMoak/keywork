import { homedir } from "node:os";
import { basename } from "node:path";
import {
  type Clock,
  type CreatureRegistry,
  type CreatureWorksite,
  type CreatureWorksitesPort,
  creatureTagOf,
  type PlaceBook,
  type PlaceProject,
  type SessionStore,
  SettingStore,
  type ShowThread,
  settingFile,
  settingsFileIn,
  type ThreadLookup,
} from "@keywork/engine";
import { type BusEnvelope, type EventLog, recordedShowEvents } from "@keywork/server";
import { canonicalPath } from "@keywork/shared";
import { workspaceStateDir } from "./node/paths.ts";
import { findSession } from "./sessions/store.ts";

export interface ServedSettingsOptions {
  log: Pick<EventLog, "record" | "subscribe">;
  file: string;
  sessionDir: string;
  notice(text: string): void;
  clock?: Clock | undefined;
  hourlyLimit?: number | undefined;
}

export type LiveThreads = (sessionId: string) => ShowThread | undefined;

export interface ServedSettings {
  settings: SettingStore;
  hostedBy(live: LiveThreads): () => void;
  close(): void;
}

export async function servedSettings(options: ServedSettingsOptions): Promise<ServedSettings> {
  const { log, file, notice } = options;
  const desk = threadDesk(storedThreads(options.sessionDir));
  const settings = await SettingStore.load({
    emit: recordedShowEvents(log),
    threads: desk.threadOf,
    storage: settingFile({ file, notice }),
    clock: options.clock,
    hourlyLimit: options.hourlyLimit,
  });
  const unfollow = log.subscribe((envelope) => {
    const removed = removedSessionOf(envelope);
    if (removed !== undefined) settings.removed(removed);
  });
  return {
    settings,
    hostedBy: desk.hostedBy,
    close: () => {
      unfollow();
      settings.close();
    },
  };
}

export function workspaceSettingsFile(place: {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
}): string {
  const userRoot = place.userRoot ?? homedir();
  return settingsFileIn(workspaceStateDir(userRoot, place.cwd, place.workspaceSlug));
}

export interface SteadPlacesOptions {
  registry: Pick<CreatureRegistry, "list">;
  cwd: string;
  workspaceSlug?: string | undefined;
  worksites?: (() => Pick<CreatureWorksitesPort, "list">) | undefined;
}

export function steadPlaces({
  registry,
  cwd,
  workspaceSlug,
  worksites,
}: SteadPlacesOptions): PlaceBook {
  const workspace = { name: workspaceSlug ?? basename(cwd), directory: cwd };
  return {
    creatures: async () =>
      (await registry.list()).map(({ slug, file }) => ({ slug, name: file.name })),
    projects: async (creature) => [
      workspace,
      ...worksitePlacesOf(creature, (await worksites?.().list()) ?? [], cwd),
    ],
  };
}

function worksitePlacesOf(
  creature: string,
  worksites: readonly CreatureWorksite[],
  workspace: string,
): PlaceProject[] {
  return worksites
    .filter((row) => row.creature === creature)
    .filter(({ directory }) => canonicalPath(directory) !== canonicalPath(workspace))
    .map(({ directory }) => ({ name: basename(directory), directory }));
}

export function showThreadOf(store: SessionStore): ShowThread {
  return {
    creature: creatureTagOf(store.entries())?.creature ?? null,
    parent: store.header.spawnedBy?.sessionId ?? null,
  };
}

export function storedThreads(sessionDir: string): ThreadLookup {
  return async (sessionId) => {
    const store = await findSession(sessionDir, sessionId);
    return store?.header.id === sessionId ? showThreadOf(store) : undefined;
  };
}

interface ThreadDesk {
  threadOf: ThreadLookup;
  hostedBy(live: LiveThreads): () => void;
}

function threadDesk(stored: ThreadLookup): ThreadDesk {
  const hosts = new Set<LiveThreads>();
  const liveAmongHosts = (sessionId: string) =>
    [...hosts].map((live) => live(sessionId)).find((thread) => thread !== undefined);
  return {
    threadOf: async (sessionId) => liveAmongHosts(sessionId) ?? stored(sessionId),
    hostedBy: (live) => {
      hosts.add(live);
      return () => hosts.delete(live);
    },
  };
}

function removedSessionOf(envelope: BusEnvelope): string | undefined {
  if (envelope.type !== "session.removed") return undefined;
  const { sessionId } = envelope.payload as { sessionId: string };
  return sessionId;
}
