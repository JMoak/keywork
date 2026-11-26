import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type CreatureHandle,
  type CreatureScenes,
  type KeeperAsker,
  type KeptScene,
  type Mood,
  machinePaneAmong,
  type SceneSeat,
  type SceneThing,
  type SettingWhat,
  type ShowSettings,
  setOutScene,
} from "@keywork/engine";
import type { CreatureScenesPort, SceneSetOutAnswer } from "@keywork/server";
import { homeScenesOf, homeTemperamentOf, sameSceneName } from "./serve-visiting.ts";

export interface ServedScenesOptions extends ScenePress {
  scenes: CreatureScenes;
  exists(slug: string): Promise<boolean>;
  conversationOf(slug: string): Promise<string | undefined>;
  temperamentOf(slug: string): Promise<Mood | undefined>;
  inProject(project: string, slug: string, name: string): Promise<SceneSetOutAnswer>;
  visitors?: VisitorScenes | undefined;
}

export interface ScenePress {
  settings: Pick<ShowSettings, "propose">;
  stillThere(what: SettingWhat): Promise<boolean>;
  asksTheKeeper?: KeeperAsker | undefined;
}

export interface VisitorScenes {
  userRoot: string;
  workspace: string;
  threadOf(creature: CreatureHandle, kept: string): Promise<string | undefined>;
}

export function servedScenes(options: ServedScenesOptions): CreatureScenesPort {
  const { scenes } = options;
  return {
    list: async (slug) => ((await options.exists(slug)) ? scenes.list(slug) : undefined),
    setOut: async (slug, name, visitor) => {
      if (visitor !== undefined)
        return setOutForAVisitor(options, { workspace: visitor, slug }, name);
      const scene = scenes.find(slug, name);
      if (scene?.keptIn !== undefined)
        return options.inProject(scene.keptIn.workspace, slug, scene.name);
      const conversation = scene === undefined ? undefined : await options.conversationOf(slug);
      if (scene === undefined || conversation === undefined) return undefined;
      const seat = { creature: slug, sessionId: conversation };
      return setOutAtThePress(options, scene, seat, await options.temperamentOf(slug));
    },
    keep: async (slug, name, { place, things, keptIn }) =>
      (await options.exists(slug)) ? scenes.keepFor(slug, name, place, things, keptIn) : undefined,
    forget: async (slug, name) => (await scenes.forget(slug, name)) !== undefined,
    subscribe: (listener) => scenes.subscribe(listener),
  };
}

export async function stillThere(
  what: SettingWhat,
  cwd: string,
  stored: (id: string) => Promise<unknown>,
): Promise<boolean> {
  if (what.kind === "file")
    return existsSync(isAbsolute(what.ref) ? what.ref : join(cwd, what.ref));
  if (what.kind === "thread") return (await stored(what.ref)) !== undefined;
  return true;
}

async function setOutForAVisitor(
  options: ServedScenesOptions,
  creature: CreatureHandle,
  name: string,
): Promise<SceneSetOutAnswer | undefined> {
  const visitors = options.visitors;
  if (visitors === undefined) return undefined;
  const scene = homeScenesOf(visitors.userRoot, creature.slug).find(
    (kept) => sameSceneName(kept.name, name) && kept.keptIn?.workspace === visitors.workspace,
  );
  if (scene?.keptIn === undefined) return undefined;
  const thread = await visitors.threadOf(creature, scene.keptIn.session);
  if (thread === undefined) return { out: 0, missing: [], asking: [], stopped: noThreadLeft };
  const seat = { creature: creature.slug, sessionId: thread };
  return setOutAtThePress(
    options,
    scene,
    seat,
    await homeTemperamentOf(visitors.userRoot, creature.slug),
  );
}

async function setOutAtThePress(
  press: ScenePress,
  scene: KeptScene,
  seat: SceneSeat,
  mood: Mood | undefined,
): Promise<SceneSetOutAnswer> {
  const there = ({ what }: SceneThing) => press.stillThere(what);
  const onTheMachine = scene.things.filter((thing) => machinePaneAmong([thing]) !== undefined);
  const onTheStage = scene.things.filter((thing) => !onTheMachine.includes(thing));
  const now = await setOutScene(
    press.settings,
    seat,
    { ...scene, things: onTheStage },
    there,
    mood,
  );
  const asker = press.asksTheKeeper;
  if (asker !== undefined) {
    for (const thing of onTheMachine) {
      void askThenSetOut(asker, press, scene, thing, seat, mood);
    }
  }
  return {
    out: now.done.length,
    missing: now.missing,
    asking: asker === undefined ? [] : onTheMachine.map(({ what }) => what.title ?? what.ref),
    stopped:
      asker === undefined && onTheMachine.length > 0
        ? (now.stopped ?? nobodyToAsk)
        : (now.stopped ?? null),
  };
}

async function askThenSetOut(
  asker: KeeperAsker,
  press: ScenePress,
  scene: KeptScene,
  thing: SceneThing,
  seat: SceneSeat,
  mood: Mood | undefined,
): Promise<void> {
  const call = {
    type: "tool-call" as const,
    callId: randomUUID(),
    name: "show",
    arguments: { scene: scene.name, what: thing.what },
  };
  const allowed = await asker(seat.sessionId, call).catch(() => false);
  if (!allowed) return;
  const there = ({ what }: SceneThing) => press.stillThere(what);
  await setOutScene(press.settings, seat, { ...scene, things: [thing] }, there, mood);
}

const nobodyToAsk =
  "a terminal or a screen acts on the keeper's machine, so the keeper says yes each time, and nobody here can ask them";

const noThreadLeft =
  "the thread the scene was kept in is gone, and the creature has no other thread in this project to set it out in";
