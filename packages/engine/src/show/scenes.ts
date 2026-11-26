import { join } from "node:path";
import { jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import type { Seat } from "./seat.ts";
import {
  type SettingPlace,
  type SettingSize,
  type SettingWeight,
  type SettingWhat,
  type SteadPlace,
  settingKinds,
  settingPlaces,
  settingSizes,
  settingWeights,
} from "./setting.ts";
import { quoted } from "./words.ts";

export const scenesPerCreature = 12;

export const sceneNameLength = 40;

export interface SceneHolding {
  kind: string;
  title: string;
}

export interface CreatureScene {
  creature: string;
  name: string;
  place: SteadPlace | null;
  holds: SceneHolding[];
  keptAt: string;
}

export interface SceneThing {
  what: SettingWhat;
  where: SettingPlace;
  seat?: Seat | undefined;
  weight?: SettingWeight | undefined;
  size?: SettingSize | undefined;
}

export interface KeptScene extends CreatureScene {
  things: SceneThing[];
  keptIn?: SceneKeptIn | undefined;
}

export interface SceneKeptIn {
  workspace: string;
  session: string;
}

export type CreatureSceneChangeKind = "kept" | "forgotten";

export interface CreatureSceneChange {
  creature: string;
  change: CreatureSceneChangeKind;
  scene: CreatureScene;
}

export type SceneKeeping =
  | { kept: KeptScene; replaced: boolean }
  | { full: readonly CreatureScene[] };

export interface SceneShelf {
  list(creature: string): CreatureScene[];
  find(creature: string, name: string): KeptScene | undefined;
  keep(
    creature: string,
    name: string,
    place: SteadPlace | null,
    things: SceneThing[],
  ): Promise<SceneKeeping>;
  forget(creature: string, name: string): Promise<CreatureScene | undefined>;
  away?(scene: KeptScene): string | undefined;
  stillThere(what: SettingWhat): Promise<boolean>;
}

export interface CreatureScenes extends SceneShelf {
  keepFor(
    creature: string,
    name: string,
    place: SteadPlace | null,
    things: SceneThing[],
    keptIn: SceneKeptIn | undefined,
  ): SceneKeeping;
  subscribe(listener: (change: CreatureSceneChange) => void): () => void;
  close(): void;
}

export interface CreatureScenesOptions {
  file: string;
  creatures: {
    subscribe(listener: (change: { slug: string; change: string }) => void): () => void;
  };
  notice(line: string): void;
  stillThere?: ((what: SettingWhat) => Promise<boolean>) | undefined;
  now?: (() => Date) | undefined;
}

export function scenesFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "scenes.json");
}

export function sceneNameOf(said: string): string {
  return said.trim().replace(/\s+/g, " ").slice(0, sceneNameLength);
}

export function creatureScenes(options: CreatureScenesOptions): CreatureScenes {
  const now = options.now ?? (() => new Date());
  const kept = keptScenes(options.file, options.notice);
  const shelf = new Map<string, KeptScene>(kept.load().map((scene) => [sceneKeyOf(scene), scene]));
  const listeners = new Set<(change: CreatureSceneChange) => void>();
  const announce = (creature: string, change: CreatureSceneChangeKind, scene: KeptScene): void => {
    for (const listener of [...listeners]) listener({ creature, change, scene: shownOf(scene) });
  };
  const save = (): void => kept.save([...shelf.values()]);
  const scenesOf = (creature: string): KeptScene[] =>
    [...shelf.values()]
      .filter((scene) => scene.creature === creature)
      .sort((left, right) => right.keptAt.localeCompare(left.keptAt));
  const unfollow = options.creatures.subscribe(({ slug, change }) => {
    if (change !== "removed") return;
    const gone = scenesOf(slug);
    if (gone.length === 0) return;
    for (const scene of gone) shelf.delete(sceneKeyOf(scene));
    save();
    for (const scene of gone) announce(slug, "forgotten", scene);
  });
  const keepFor: CreatureScenes["keepFor"] = (creature, said, place, things, keptIn) => {
    const name = sceneNameOf(said);
    const before = shelf.get(sceneKeyOf({ creature, name }));
    const others = scenesOf(creature);
    if (before === undefined && others.length >= scenesPerCreature)
      return { full: others.map(shownOf) };
    const scene: KeptScene = {
      creature,
      name,
      place,
      holds: things.map(({ what }) => holdingOf(what)),
      keptAt: now().toISOString(),
      things,
      ...(keptIn !== undefined && { keptIn }),
    };
    shelf.set(sceneKeyOf(scene), scene);
    save();
    announce(creature, "kept", scene);
    return { kept: scene, replaced: before !== undefined };
  };
  return {
    list: (creature) => scenesOf(creature).map(shownOf),
    find: (creature, name) => shelf.get(sceneKeyOf({ creature, name })),
    keep: async (creature, name, place, things) =>
      keepFor(creature, name, place, things, undefined),
    keepFor,
    forget: async (creature, name) => {
      const scene = shelf.get(sceneKeyOf({ creature, name }));
      if (scene === undefined) return undefined;
      shelf.delete(sceneKeyOf(scene));
      save();
      announce(creature, "forgotten", scene);
      return shownOf(scene);
    },
    away: (scene) => (scene.keptIn === undefined ? undefined : keptInAProject(scene)),
    stillThere: options.stillThere ?? (async () => true),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: unfollow,
  };
}

export function holdingOf(what: SettingWhat): SceneHolding {
  return { kind: what.kind, title: (what.title ?? what.ref).slice(0, holdingTitleLength) };
}

export function keptScenesIn(file: string): KeptScene[] {
  try {
    return (scenesStoreAt(file).read()?.scenes ?? []) as KeptScene[];
  } catch {
    return [];
  }
}

export function keptInAProject({ name, place }: KeptScene): string {
  const where = place?.kind === "project" ? ` at ${place.directory}` : "";
  return `${quoted(name)} was kept in a thread of yours in the project${where}, and it is set out there: from a thread in that project, or when the keeper presses its place in the stead`;
}

export function keptElsewhere({ name }: KeptScene): string {
  return `${quoted(name)} was kept outside this project, and it is set out where it was kept, or when the keeper presses its place in the stead`;
}

export function shownOf({ things: _things, keptIn: _keptIn, ...scene }: KeptScene): CreatureScene {
  return scene;
}

const holdingTitleLength = 80;

function sceneKeyOf({ creature, name }: Pick<CreatureScene, "creature" | "name">): string {
  return JSON.stringify([creature, sceneNameOf(name).toLowerCase()]);
}

interface KeptScenes {
  load(): KeptScene[];
  save(scenes: KeptScene[]): void;
}

const keptVersion = 1;

const keptTime = z.string().refine((at) => !Number.isNaN(Date.parse(at)), "is a time");

const keptPlace = z.union([
  z.strictObject({ kind: z.literal("workshop"), creature: z.string().min(1) }),
  z.strictObject({ kind: z.enum(["porch", "store", "mill"]) }),
  z.strictObject({
    kind: z.literal("project"),
    creature: z.string().min(1),
    directory: z.string().min(1),
  }),
]);

const keptSeat = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

const keptThing = z.strictObject({
  what: z.strictObject({
    kind: z.enum(settingKinds),
    ref: z.string().min(1),
    title: z.string().min(1).optional(),
  }),
  where: z.enum(settingPlaces),
  seat: keptSeat.optional(),
  weight: z.enum(settingWeights).optional(),
  size: z.enum(settingSizes).optional(),
});

const keptIn = z.strictObject({ workspace: z.string().min(1), session: z.string().min(1) });

const keptScene = z.strictObject({
  creature: z.string().min(1),
  name: z.string().min(1).max(sceneNameLength),
  place: keptPlace.nullable(),
  holds: z.array(z.strictObject({ kind: z.string().min(1), title: z.string() })),
  keptAt: keptTime,
  things: z.array(keptThing).min(1),
  keptIn: keptIn.optional(),
});

const keptFile = z.strictObject({
  version: z.literal(keptVersion),
  scenes: z.array(keptScene),
});

export const sceneKeepingInput = z.strictObject({
  place: keptPlace.nullable(),
  things: z.array(keptThing).min(1),
  keptIn,
});

export interface SceneKeepingInput {
  place: SteadPlace | null;
  things: SceneThing[];
  keptIn: SceneKeptIn;
}

function scenesStoreAt(file: string) {
  return jsonFileStore({
    file,
    mode: "strict",
    private: true,
    validate: keptFileOf,
    error: (at, detail) => new Error(`${at} is ${detail}`),
  });
}

function keptScenes(file: string, notice: (line: string) => void): KeptScenes {
  const store = scenesStoreAt(file);
  let lastSaveFailed = false;
  return {
    load: () => {
      try {
        return (store.read()?.scenes ?? []) as KeptScene[];
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return [];
      }
    },
    save: (scenes) => {
      try {
        store.write({ version: keptVersion, scenes });
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

function keptFileOf(data: unknown): z.infer<typeof keptFile> {
  const parsed = keptFile.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const at = issue?.path.join(".") ?? "";
  throw new Error(`not a shelf of scenes: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(file: string): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the scenes kept at ${file} are unreadable (${oneLine(toError(cause).message)}); the creatures start again with none and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `scenes could not be saved to ${file} (${oneLine(toError(cause).message)}); they stay kept in memory and the next change saves them again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
