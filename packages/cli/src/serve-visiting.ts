import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type Creature,
  type CreatureHandle,
  CreatureRegistry,
  type CreatureSessionTag,
  type CreatureTemperamentFacts,
  creatureTagOf,
  type KeptScene,
  keptElsewhere,
  keptScenesIn,
  type Mood,
  mannerOf,
  type SceneKeeping,
  type SceneKeepingInput,
  type SceneShelf,
  type SessionEntry,
  type SettingWhat,
  type SteadPlace,
  sceneNameOf,
  scenesFileIn,
  shownOf,
  type Temperament,
  type TemperamentSeat,
  temperamentFactsOf,
  temperamentSeatOf,
} from "@keywork/engine";
import { resolveAnchor } from "@keywork/shared";
import { workspaceStateDir } from "./node/paths.ts";
import { existingManagedHome } from "./paths.ts";

export const projectThreadType = "keywork.creature-project";

export interface ProjectThreadTag {
  key: string;
  creature: CreatureHandle;
}

export interface VisitingSeat {
  temperament(): Promise<Mood | undefined>;
  temperaments: TemperamentSeat;
  scenes: SceneShelf;
  home(): SteadPlace;
}

export interface HomeScenes {
  keep(creature: CreatureHandle, name: string, keeping: SceneKeepingInput): Promise<SceneKeeping>;
  forget(creature: CreatureHandle, name: string): Promise<boolean>;
}

export interface HomeManners {
  take(
    creature: CreatureHandle,
    temperament: Temperament,
  ): Promise<CreatureTemperamentFacts | undefined>;
}

export interface VisitingOptions {
  userRoot: string;
  workspace: string;
  homeScenes: HomeScenes;
  homeManners: HomeManners;
  worksiteOf(conversation: string): string | undefined;
  stillThere(what: SettingWhat): Promise<boolean>;
}

export interface VisitingThread {
  id: string;
  cwd: string;
}

export function projectThreadTag(entries: readonly SessionEntry[]): ProjectThreadTag | undefined {
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== projectThreadType ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const candidate = entry.data as Partial<ProjectThreadTag>;
    if (
      typeof candidate.key === "string" &&
      typeof candidate.creature?.workspace === "string" &&
      typeof candidate.creature.slug === "string"
    )
      return { key: candidate.key, creature: candidate.creature };
  }
  return undefined;
}

export function workingCreatureOf(
  entries: readonly SessionEntry[],
): CreatureSessionTag | undefined {
  const own = creatureTagOf(entries);
  if (own !== undefined) return own;
  const visiting = projectThreadTag(entries);
  return visiting === undefined ? undefined : { creature: visiting.creature.slug, kind: "thread" };
}

export function sameHandle(one: CreatureHandle | undefined, other: CreatureHandle): boolean {
  return one?.workspace === other.workspace && one.slug === other.slug;
}

export function actingCreatureOf(entries: readonly SessionEntry[]): string | null {
  return creatureTagOf(entries)?.creature ?? projectThreadTag(entries)?.creature.slug ?? null;
}

export function visitingSeat(
  options: VisitingOptions,
  creature: CreatureHandle,
  thread: VisitingThread,
): VisitingSeat {
  return {
    temperament: () => homeTemperamentOf(options.userRoot, creature.slug),
    temperaments: temperamentSeatOf(
      {
        read: async () => homeTemperamentsOf(options.userRoot, creature.slug),
        takeManner: (_slug, temperament) => options.homeManners.take(creature, temperament),
      },
      creature.slug,
    ),
    scenes: homeSceneShelf(options, creature, thread.id),
    home: () => ({
      kind: "project",
      creature: creature.slug,
      directory: options.worksiteOf(thread.id) ?? thread.cwd,
    }),
  };
}

export function fileExistsIn(cwd: string): (ref: string) => Promise<boolean> {
  const roots = [cwd, resolveAnchor(cwd).root];
  return async (ref) =>
    isAbsolute(ref) ? existsSync(ref) : roots.some((root) => existsSync(join(root, ref)));
}

export async function homeTemperamentOf(userRoot: string, slug: string): Promise<Mood | undefined> {
  const found = await homeCreatureOf(userRoot, slug);
  return found === undefined ? undefined : mannerOf(found.file);
}

async function homeTemperamentsOf(
  userRoot: string,
  slug: string,
): Promise<CreatureTemperamentFacts | undefined> {
  const found = await homeCreatureOf(userRoot, slug);
  return found === undefined ? undefined : temperamentFactsOf(found.file);
}

async function homeCreatureOf(userRoot: string, slug: string): Promise<Creature | undefined> {
  const home = managedHomeOf(userRoot);
  if (home === undefined) return undefined;
  const registry = new CreatureRegistry({ root: home, trusted: true, keeper: "" });
  return registry.read(slug).catch(() => undefined);
}

export async function homeCreaturesOf(userRoot: string): Promise<Creature[]> {
  const home = managedHomeOf(userRoot);
  if (home === undefined) return [];
  const registry = new CreatureRegistry({ root: home, trusted: true, keeper: "" });
  return registry.list().catch(() => []);
}

export function homeScenesOf(userRoot: string, creature: string): KeptScene[] {
  const home = managedHomeOf(userRoot);
  if (home === undefined) return [];
  const kept = keptScenesIn(scenesFileIn(workspaceStateDir(userRoot, home)));
  return kept.filter((scene) => scene.creature === creature);
}

export function sameSceneName(one: string, other: string): boolean {
  return sceneNameOf(one).toLowerCase() === sceneNameOf(other).toLowerCase();
}

function homeSceneShelf(
  options: VisitingOptions,
  creature: CreatureHandle,
  session: string,
): SceneShelf {
  const kept = () => homeScenesOf(options.userRoot, creature.slug);
  const named = (name: string) => kept().find((scene) => sameSceneName(scene.name, name));
  const keptIn = { workspace: options.workspace, session };
  return {
    list: () =>
      kept()
        .sort((left, right) => right.keptAt.localeCompare(left.keptAt))
        .map(shownOf),
    find: (_creature, name) => named(name),
    keep: (_creature, name, place, things) =>
      options.homeScenes.keep(creature, name, { place, things, keptIn }),
    forget: async (_creature, name) => {
      const scene = named(name);
      if (scene === undefined || !(await options.homeScenes.forget(creature, scene.name)))
        return undefined;
      return shownOf(scene);
    },
    away: (scene) =>
      scene.keptIn?.workspace === options.workspace ? undefined : keptElsewhere(scene),
    stillThere: options.stillThere,
  };
}

function managedHomeOf(userRoot: string): string | undefined {
  try {
    return existingManagedHome(userRoot);
  } catch {
    return undefined;
  }
}
