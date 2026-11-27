import { z } from "zod";
import {
  cloudFallbackSchema,
  type ModelClass,
  type ModelPolicy,
  type ModelPolicySlot,
  modelClasses,
  modelPolicySchema,
  modelPolicySlotSchema,
} from "../models/policy/types.ts";
import type { Mood } from "../show/setting.ts";
import { listed } from "../show/words.ts";
import { type InboundPolicy, inboundPolicySchema } from "./inbound.ts";
import { introductionOf } from "./prompt.ts";

export type { ModelClass, ModelPolicy };
export { modelClasses };

export const creatureFileName = "creature.json";
export const hostWorkshop = "host";
export const defaultSkin = "cairn";
export const defaultRoutinesDir = "routines";
export const seedLimit = 0xffffffff;

export type ModelChoice = ModelPolicySlot;

export const temperaments = [
  "calm",
  "brisk",
  "eager",
  "playful",
  "decisive",
  "tentative",
] as const satisfies readonly Mood[];

export type Temperament = (typeof temperaments)[number];

export const rangeSize = 3;

export interface TakenManner {
  now: Temperament;
  since: string;
}

export type CreatureTemperaments = Pick<CreatureFile, "temperament" | "body" | "range" | "manner">;

export function temperamentOf(file: Pick<CreatureFile, "temperament" | "body">): Temperament {
  return file.temperament ?? temperamentOfSeed(file.body.seed);
}

export function rangeOf(file: Pick<CreatureFile, "temperament" | "body" | "range">): Temperament[] {
  const favourite = temperamentOf(file);
  return inOrder(file.range ?? [favourite, ...othersOfSeed(file.body.seed, favourite)]);
}

export function mannerOf(file: CreatureTemperaments): Temperament {
  const taken = file.manner?.now;
  return taken !== undefined && rangeOf(file).includes(taken) ? taken : temperamentOf(file);
}

export function isTemperament(value: unknown): value is Temperament {
  return temperaments.some((temperament) => temperament === value);
}

export class OutsideRangeError extends Error {
  constructor(
    readonly asked: string,
    readonly range: readonly Temperament[],
  ) {
    super(`${asked} is not one of its temperaments; it can be ${listed(range, "or")}`);
    this.name = "OutsideRangeError";
  }
}

export function withManner(file: CreatureFile, temperament: Temperament, at: Date): CreatureFile {
  const range = rangeOf(file);
  if (!range.includes(temperament)) throw new OutsideRangeError(temperament, range);
  const settled = settledFile(file);
  return temperament === settled.temperament
    ? settled
    : { ...settled, manner: { now: temperament, since: at.toISOString() } };
}

export function settledFile(file: CreatureFile): CreatureFile {
  const { manner: _was, ...settled } = file;
  return { ...settled, temperament: temperamentOf(file), range: rangeOf(file) };
}

export interface CreatureBody {
  skin: string;
  seed: number;
}

export interface CreatureFile {
  name: string;
  created: string;
  introduction: string;
  body: CreatureBody;
  workshop: string;
  models: ModelPolicy;
  cloudFallback?: boolean | undefined;
  routines: string;
  paused?: CreaturePaused | undefined;
  inbound?: InboundPolicy | undefined;
  temperament?: Temperament | undefined;
  range?: Temperament[] | undefined;
  manner?: TakenManner | undefined;
}

export interface CreaturePaused {
  since: string;
  chores: string[];
}

export interface CreaturePatch {
  name?: string | undefined;
  body?: Partial<CreatureBody> | undefined;
  models?: Partial<ModelPolicy> | undefined;
  cloudFallback?: boolean | undefined;
  inbound?: InboundPolicy | undefined;
  temperament?: Temperament | undefined;
}

export interface CreatureFileDraft {
  name: string;
  created: string;
  introduction: string;
  seed: number;
  skin?: string | undefined;
  workshop?: string | undefined;
  models?: Partial<ModelPolicy> | undefined;
  cloudFallback?: boolean | undefined;
  temperament?: Temperament | undefined;
}

export class MalformedCreatureError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`malformed ${file}: ${detail}`);
    this.name = "MalformedCreatureError";
  }
}

export class UnusableModelError extends Error {
  constructor(
    message: string,
    readonly refused: string,
    readonly usable: readonly string[],
  ) {
    super(message);
    this.name = "UnusableModelError";
  }
}

export function inheritEverywhere(): ModelPolicy {
  return { strong: "inherit", loop: "inherit", decide: "inherit", vision: "inherit" };
}

export function creatureFileOf(draft: CreatureFileDraft): CreatureFile {
  return {
    name: draft.name,
    created: draft.created,
    introduction: draft.introduction,
    body: { skin: draft.skin ?? defaultSkin, seed: draft.seed },
    workshop: draft.workshop ?? hostWorkshop,
    models: { ...inheritEverywhere(), ...definedChoices(draft.models) },
    ...(draft.cloudFallback !== undefined && { cloudFallback: draft.cloudFallback }),
    routines: defaultRoutinesDir,
    temperament: draft.temperament ?? temperamentOfSeed(draft.seed),
  };
}

export function patchedCreatureFile(
  file: CreatureFile,
  patch: CreaturePatch,
  keeper: string,
): CreatureFile {
  const name = patch.name?.trim() ?? file.name;
  const introduction =
    file.introduction === introductionOf(file.name, keeper)
      ? introductionOf(name, keeper)
      : file.introduction;
  const range = rangeOf(file);
  if (patch.temperament !== undefined && !range.includes(patch.temperament))
    throw new OutsideRangeError(patch.temperament, range);
  const kept = patch.temperament === undefined ? file : settledFile(file);
  return {
    ...kept,
    name,
    introduction,
    body: { ...file.body, ...definedBody(patch.body) },
    models: { ...file.models, ...definedChoices(patch.models) },
    ...(patch.cloudFallback !== undefined && { cloudFallback: patch.cloudFallback }),
    ...(patch.inbound !== undefined && { inbound: patch.inbound }),
    temperament: patch.temperament ?? temperamentOf(file),
    range,
  };
}

export function validCreatureFile(file: CreatureFile, where: string): CreatureFile {
  return parseCreatureFile(JSON.stringify(file), where);
}

export function parseCreatureFile(raw: string, file: string): CreatureFile {
  const outcome = creatureFileSchema.safeParse(jsonOf(raw, file));
  if (outcome.success) return outcome.data;
  const first = outcome.error.issues[0];
  const where = first?.path.map(String).join(".") ?? "";
  const message = first?.message ?? "invalid creature";
  throw new MalformedCreatureError(file, where === "" ? message : `${where}: ${message}`);
}

export function serializeCreatureFile(file: CreatureFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function isModelChoice(value: unknown): value is ModelChoice {
  return modelPolicySlotSchema.removeDefault().safeParse(value).success;
}

const skinId = /^[a-z][a-z0-9-]*$/;

const cloudFallbackChoice = cloudFallbackSchema
  .removeDefault()
  .optional()
  .describe(cloudFallbackSchema.description ?? "");

export const creatureFileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe(
        "The keeper's name for the creature, editable any time; the directory slug is its handle and never changes, so the name has to live here (REQ-003).",
      ),
    created: z.iso
      .datetime()
      .describe("When the creature was made; the stead grows its workshop from this moment."),
    introduction: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The one sentence the creature composed about itself at creation, injected ahead of its prompt and editable by the keeper; it never replaces the bot's prompt.",
      ),
    body: z
      .object({
        skin: z
          .string()
          .regex(skinId, "skin ids are lowercase kebab-case")
          .describe(
            "The habitat skin that draws this creature; a missing skin disables the body, never the creature.",
          ),
        seed: z
          .int()
          .min(0)
          .max(seedLimit)
          .describe(
            "Seeds the habitat's idle choices and jitter so the same creature moves the same way on every console.",
          ),
      })
      .strict()
      .describe(
        "The creature's body on the stead: which skin draws it and the seed its motion follows.",
      ),
    workshop: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Where its threads run by default: a workshop id from the workshop registry, or "host" for the bare node.',
      ),
    models: modelPolicySchema.describe(
      "Which model answers each task class; the nearest policy wins (creature, then workspace, then user).",
    ),
    cloudFallback: cloudFallbackChoice,
    routines: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The directory under the creature holding its routine files, each one a file the keeper can read.",
      ),
    paused: z
      .object({
        since: z.iso.datetime().describe("When the keeper paused the creature."),
        chores: z
          .array(z.string())
          .describe(
            "The routines the pause switched off, so resuming switches back on exactly these and leaves the ones the keeper had off alone.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Present while the keeper has paused the creature: its routines stop firing and its live threads finish; absent when it runs.",
      ),
    inbound: inboundPolicySchema
      .optional()
      .describe(
        'Who may message this creature over the mesh (RUN-073 to RUN-075): "nobody", "paired" (creatures on this machine or a machine the keeper paired, the default when absent) or { named: [...] }, creature slugs optionally pinned with @machine; a message is plain text and never carries consent.',
      ),
    temperament: z
      .enum(temperaments)
      .optional()
      .describe(
        "The creature's favourite temperament, one of the window tools' moods without urgent: the manner it hatched with or the keeper chose, and the one it settles back to. Absent in a file made before it existed, when it is read from the seed, so the same creature always has the same one.",
      ),
    range: z
      .array(z.enum(temperaments))
      .length(rangeSize)
      .refine((range) => new Set(range).size === range.length, "range repeats a temperament")
      .optional()
      .describe(
        "The three temperaments the creature can be, its favourite among them, so creatures differ in what they can be. Absent until anything about the creature changes, when the two besides the favourite are drawn from the seed, the same every time; written then, so a later change of seed keeps them.",
      ),
    manner: z
      .object({
        now: z.enum(temperaments).describe("The other temperament of its range it is in now."),
        since: z.iso.datetime().describe("When it took that manner on."),
      })
      .strict()
      .optional()
      .describe(
        "Present while the creature has put itself into another temperament of its range; the engine removes it when the creature settles back to its favourite after a quiet half hour, or when the keeper chooses its favourite.",
      ),
  })
  .strict()
  .superRefine((file, context) => {
    const favourite = file.temperament ?? temperamentOfSeed(file.body.seed);
    if (file.range !== undefined && !file.range.includes(favourite))
      context.addIssue({
        code: "custom",
        path: ["range"],
        message: `the range must hold the favourite temperament, ${favourite}`,
      });
  });

function temperamentOfSeed(seed: number): Temperament {
  return temperaments[seed % temperaments.length] ?? "brisk";
}

function othersOfSeed(seed: number, favourite: Temperament): Temperament[] {
  const rest = temperaments.filter((temperament) => temperament !== favourite);
  const first = rest[Math.floor(seed / temperaments.length) % rest.length] ?? "brisk";
  const left = rest.filter((temperament) => temperament !== first);
  const second = left[Math.floor(seed / (temperaments.length * rest.length)) % left.length];
  return second === undefined ? [first] : [first, second];
}

function inOrder(range: readonly Temperament[]): Temperament[] {
  return temperaments.filter((temperament) => range.includes(temperament));
}

function definedBody(body: Partial<CreatureBody> | undefined): Partial<CreatureBody> {
  return {
    ...(body?.skin !== undefined && { skin: body.skin }),
    ...(body?.seed !== undefined && { seed: body.seed }),
  };
}

function definedChoices(models: Partial<ModelPolicy> | undefined): Partial<ModelPolicy> {
  const defined: Partial<ModelPolicy> = {};
  for (const modelClass of modelClasses) {
    const choice = models?.[modelClass];
    if (choice !== undefined) defined[modelClass] = choice;
  }
  return defined;
}

function jsonOf(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new MalformedCreatureError(file, cause instanceof Error ? cause.message : String(cause));
  }
}
