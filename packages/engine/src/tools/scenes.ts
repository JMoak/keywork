import { z } from "zod";
import { quotedNameOf } from "../show/naming.ts";
import { noPlaceBook, placeCalled, placeSaid, samePlace } from "../show/places.ts";
import {
  type CreatureScene,
  type KeptScene,
  type SceneThing,
  sceneNameLength,
  scenesPerCreature,
} from "../show/scenes.ts";
import { seatWords } from "../show/seat.ts";
import {
  type MachinePane,
  type Mood,
  machinePanes,
  type SettingAgent,
  type SteadPlace,
} from "../show/setting.ts";
import type { Stood } from "../show/standing.ts";
import type { SetOut } from "../show/store.ts";
import { listed, quoted } from "../show/words.ts";
import type { ShowSettings, ShowTarget } from "./show.ts";

export const sceneNameInput = z.string().trim().min(1).max(sceneNameLength);

export interface SceneSeat {
  creature: string;
  sessionId: string;
  agent?: SettingAgent | undefined;
  home?: SteadPlace | undefined;
}

export interface SceneSetOut {
  done: SetOut[];
  missing: string[];
  stopped: string | undefined;
}

export function machinePaneOfScene(
  target: Pick<ShowTarget, "creature" | "scenes">,
  name: unknown,
): MachinePane | undefined {
  if (typeof name !== "string") return undefined;
  const scene = sceneNamed(target, name);
  return typeof scene === "string" ? undefined : machinePaneAmong(scene.things);
}

export function machinePaneAmong(things: readonly SceneThing[]): MachinePane | undefined {
  for (const { what } of things) {
    const machine = machinePanes.find((pane) => what.kind === "pane" && what.ref === pane);
    if (machine !== undefined) return machine;
  }
  return undefined;
}

export async function setOutScene(
  settings: Pick<ShowSettings, "propose">,
  seat: SceneSeat,
  scene: KeptScene,
  stillThere: (thing: SceneThing) => Promise<boolean>,
  mood: Mood | undefined,
): Promise<SceneSetOut> {
  const done: SetOut[] = [];
  const missing: string[] = [];
  for (const thing of scene.things) {
    if (!(await stillThere(thing))) {
      missing.push(thing.what.title ?? thing.what.ref);
      continue;
    }
    const outcome = settings.propose({
      creature: seat.creature,
      sessionId: seat.sessionId,
      what: thing.what,
      rung: "card",
      why: "",
      until: "seen",
      from: null,
      origin: "creature",
      where: thing.where,
      ...(thing.seat !== undefined && { seat: thing.seat }),
      ...(thing.weight !== undefined && { weight: thing.weight }),
      ...(thing.size !== undefined && { size: thing.size }),
      ...(mood !== undefined && { mood }),
      ...(seat.agent !== undefined && { agent: seat.agent }),
      ...placeOf(scene, seat),
      keeps: { rung: true, why: true, until: true },
    });
    if ("refused" in outcome) return { done, missing, stopped: `Not set out: ${outcome.error}.` };
    done.push(outcome);
  }
  return { done, missing, stopped: undefined };
}

function placeOf(scene: KeptScene, seat: SceneSeat): { place?: SteadPlace } {
  const place = scene.place ?? seat.home;
  return place === undefined ? {} : { place };
}

export interface KeepAsk {
  name: string;
  panes: readonly string[] | undefined;
  from: string | undefined;
}

export async function keptSceneWords(
  settings: ShowSettings,
  target: ShowTarget,
  ask: KeepAsk,
  idOf: (said: string) => string | undefined,
): Promise<string> {
  const { creature, scenes } = target;
  if (creature === null || scenes === undefined) return noCreatureToKeep;
  const mine = settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.origin === "creature");
  const chosen = chosenOf(mine, ask.panes, idOf);
  if (typeof chosen === "string") return chosen;
  if (chosen.length === 0) return nothingToKeep;
  const place = await sceneGround(target, ask.from, chosen);
  if (typeof place === "string") return place;
  const things = chosen.map(thingOf);
  const keeping = await scenes.keep(creature, ask.name, place, things);
  if ("full" in keeping) return fullWords(keeping.full);
  const { kept, replaced } = keeping;
  return [
    `${replaced ? "Kept again" : "Kept"} as the scene ${quoted(kept.name)}: ${heldWords(chosen)}.`,
    ...(replaced ? ["It now holds these in place of what it held before."] : []),
    ...(place === null
      ? []
      : [
          `It belongs to ${placeSaid(place, creature)}: pressing that place in the stead sets it out.`,
        ]),
    `Set it out again with arrange and scene ${quoted(kept.name)}; shown lists the scenes you keep.`,
  ].join(" ");
}

export async function forgottenWords(target: ShowTarget, name: string): Promise<string> {
  const { creature, scenes } = target;
  if (creature === null || scenes === undefined) return noCreatureToKeep;
  const forgotten = await scenes.forget(creature, name);
  if (forgotten === undefined) return `Not forgotten: ${noSuchScene(name)}.`;
  return `Forgot the scene ${quoted(forgotten.name)}. Nothing that is out moved.`;
}

export function sceneNamed(
  target: Pick<ShowTarget, "creature" | "scenes">,
  name: string,
): KeptScene | string {
  const { creature, scenes } = target;
  if (creature === null || scenes === undefined)
    return "scenes are kept by a creature, and this conversation belongs to none";
  const scene = scenes.find(creature, name);
  if (scene === undefined) return noSuchScene(name);
  return scenes.away?.(scene) ?? scene;
}

export function missingWords(missing: readonly string[]): string[] {
  if (missing.length === 0) return [];
  const named = listed(
    missing.map((title) => quoted(title)),
    "and",
  );
  return [
    `${named} ${missing.length === 1 ? "is" : "are"} no longer there, so ${missing.length === 1 ? "it was" : "they were"} left out.`,
  ];
}

export function scenesListedWords(target: Pick<ShowTarget, "creature" | "scenes">): string[] {
  const { creature, scenes } = target;
  if (creature === null || scenes === undefined) return [];
  const kept = scenes.list(creature);
  if (kept.length === 0)
    return ["You keep no scenes; arrange with keep keeps what is out under a name."];
  const each = kept.map((scene) => `${quoted(scene.name)} (${sceneSize(scene, creature)})`);
  return [`Scenes you keep, newest first: ${each.join("; ")}.`];
}

const noCreatureToKeep =
  "Not kept: scenes are kept by a creature, and this conversation belongs to none.";

const nothingToKeep =
  "Not kept: nothing of yours is out to keep; set things out with show, then keep them.";

function noSuchScene(name: string): string {
  return `you keep no scene called ${quoted(name)}; shown lists the scenes you keep`;
}

function fullWords(full: readonly CreatureScene[]): string {
  const names = listed(
    full.map(({ name }) => quoted(name)),
    "and",
  );
  return `Not kept: you already keep ${scenesPerCreature} scenes, the most a creature may (${names}); forget one with arrange and forget, or keep this under the name of one you no longer need.`;
}

function sceneSize(scene: CreatureScene, creature: string): string {
  const count = scene.holds.length === 1 ? "1 thing" : `${scene.holds.length} things`;
  return scene.place === null ? count : `${count}, from ${placeSaid(scene.place, creature)}`;
}

function chosenOf(
  mine: readonly Stood[],
  panes: readonly string[] | undefined,
  idOf: (said: string) => string | undefined,
): Stood[] | string {
  if (panes === undefined || panes.every((said) => said.trim().toLowerCase() === "all"))
    return [...mine];
  const chosen: Stood[] = [];
  for (const said of panes) {
    const id = idOf(said);
    const stood = mine.find(({ setting }) => setting.id === id);
    if (stood === undefined)
      return `Not kept: panes names ${quoted(said)}, and nothing you set out is out as that; shown lists what is out.`;
    if (!chosen.includes(stood)) chosen.push(stood);
  }
  return chosen;
}

async function sceneGround(
  target: ShowTarget,
  from: string | undefined,
  chosen: readonly Stood[],
): Promise<SteadPlace | null | string> {
  if (from !== undefined) {
    const reading = await placeCalled(from, target.creature, target.places ?? noPlaceBook);
    return "place" in reading
      ? reading.place
      : `Not kept: from names the place the scene belongs to, and ${reading.unknown}.`;
  }
  const [first, ...rest] = chosen.map(({ setting }) => setting.place);
  const shared = first !== undefined && rest.every((place) => samePlace(place, first));
  if (shared && first.kind === "project") return first;
  return target.home?.kind === "project" ? target.home : null;
}

function thingOf({ setting, where, seat }: Stood): SceneThing {
  const outside = where === "outside";
  const kept = outside ? (seat ?? setting.seat) : undefined;
  return {
    what: setting.what,
    where: outside ? "outside" : "beside",
    ...(kept !== undefined && { seat: kept }),
    ...(setting.weight !== undefined && { weight: setting.weight }),
    ...(setting.size !== undefined && { size: setting.size }),
  };
}

function heldWords(chosen: readonly Stood[]): string {
  const each = chosen.map(({ setting, where, seat }) => {
    const name = quotedNameOf(setting.what);
    if (where !== "outside") return `${name} beside the conversation`;
    const kept = seat ?? setting.seat;
    return kept === undefined ? `${name} outside` : `${name} in ${seatWords(kept)}`;
  });
  const count = chosen.length === 1 ? "1 thing" : `${chosen.length} things`;
  return `${count} as they stand now, ${listed(each, "and")}`;
}
