import { relative } from "node:path";
import {
  builtinDecider,
  jevClient,
  jevDecider,
  type MemoryDecider,
  withFallback,
} from "../../packages/engine/src/index.ts";
import { cassetteArm, cassetteGaps, cassettePath, readCassette } from "./cassette.ts";
import type { DecisionPoint } from "./corpus.ts";
import { builtinArm, type DeciderArm, type DeciderEdition, offArm, portArm } from "./replay.ts";

export const armNames = ["builtin", "off", "jev"] as const;

export type ArmName = (typeof armNames)[number];

export const jevEdition: DeciderEdition = { decider: "jev", version: "1.13.0" };

export type LiveDeciders = { readonly [name in "jev"]: (key: string) => MemoryDecider };

export interface ArmContext {
  corpusDir: string;
  points: readonly DecisionPoint[];
  env: Record<string, string | undefined>;
  record?: boolean;
  live?: LiveDeciders;
}

export type ArmSource = "rule" | "cassette" | "live";

export type OpenedArm =
  | { kind: "ready"; arm: DeciderArm; source: ArmSource; cassette?: string }
  | { kind: "skipped"; edition: DeciderEdition; reason: string };

export const liveDeciders: LiveDeciders = {
  jev: (key) =>
    withFallback(jevDecider({ client: jevClient({ key }), trial: true }), builtinDecider()),
};

export function isArmName(name: string): name is ArmName {
  return (armNames as readonly string[]).includes(name);
}

export async function openArm(name: ArmName, context: ArmContext): Promise<OpenedArm> {
  switch (name) {
    case "builtin":
      return { kind: "ready", arm: builtinArm(), source: "rule" };
    case "off":
      return { kind: "ready", arm: offArm(), source: "rule" };
    case "jev":
      return openJev(context);
  }
}

export function typesafeKey(env: Record<string, string | undefined>): string | undefined {
  return [env.KEYWORK_TYPESAFE_API_KEY, env.TYPESAFE_API_KEY].find(
    (value) => value !== undefined && value.trim() !== "",
  );
}

async function openJev(context: ArmContext): Promise<OpenedArm> {
  const cassette = cassettePath(context.corpusDir, jevEdition);
  const shown = relative(process.cwd(), cassette).split("\\").join("/");
  const recorded = context.record === true ? undefined : await readCassette(cassette);
  const gaps = recorded === undefined ? [] : cassetteGaps(recorded, context.points);
  if (recorded !== undefined && gaps.length === 0)
    return { kind: "ready", arm: cassetteArm(jevEdition, recorded), source: "cassette" };
  const key = typesafeKey(context.env);
  if (key === undefined)
    return skipped(
      recorded === undefined
        ? `no cassette at ${shown} and no TypeSafe key (KEYWORK_TYPESAFE_API_KEY or TYPESAFE_API_KEY) to record one`
        : `the cassette at ${shown} answers ${context.points.length - gaps.length} of ${context.points.length} decision points as the corpus now states them, and no TypeSafe key is set to record a fresh one`,
    );
  const live = (context.live ?? liveDeciders).jev(key);
  return { kind: "ready", arm: portArm(jevEdition, live), source: "live", cassette };
}

function skipped(reason: string): OpenedArm {
  return { kind: "skipped", edition: jevEdition, reason };
}
