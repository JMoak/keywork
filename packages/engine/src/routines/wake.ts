import { dayMs, hourMs, isoOf, minuteMs } from "./clock.ts";
import {
  type GrantRule,
  isInstant,
  parseRoutine,
  type Routine,
  type ToolPosture,
} from "./routine.ts";

export interface WakeRequest {
  note: string;
  inMinutes?: number | undefined;
  at?: string | undefined;
  everyMinutes?: number | undefined;
  tools?: ToolPosture | undefined;
  grants?: readonly GrantRule[] | undefined;
}

export interface WakeSettings {
  everyFloorMinutes: number;
  horizonMs: number;
  perHour: number;
  livePerCreature: number;
}

export const defaultWakeSettings: WakeSettings = {
  everyFloorMinutes: 15,
  horizonMs: 7 * dayMs,
  perHour: 6,
  livePerCreature: 12,
};

export type WakeBuild = { routine: Routine } | { problem: string };

export function wakeRoutineOf(
  request: WakeRequest,
  id: string,
  now: number,
  settings: WakeSettings,
): WakeBuild {
  const trigger = wakeTriggerOf(request, now, settings);
  if ("problem" in trigger) return trigger;
  const parsed = parseRoutine({
    id,
    title: `Wake: ${firstLineOf(request.note)}`,
    instructions: request.note,
    trigger: trigger.trigger,
    tools: request.tools ?? "read-only",
    grants: request.grants ?? [],
    wake: { requestedAt: isoOf(now) },
  });
  return "problem" in parsed ? { problem: parsed.problem } : parsed;
}

export function wakeIdOf(now: number, taken: (id: string) => boolean): string {
  const base = `wake-${now.toString(36)}`;
  let id = base;
  for (let suffix = 2; taken(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

export function coversGrants(accepted: Routine, wanted: Routine): boolean {
  return (
    postureRank[accepted.tools] >= postureRank[wanted.tools] &&
    wanted.grants.every((rule) =>
      accepted.grants.some(
        (held) => held.action === rule.action && held.resource === rule.resource,
      ),
    )
  );
}

export function wakeLimitOf(
  requestedInLastHour: number,
  live: number,
  settings: WakeSettings,
): string | undefined {
  if (requestedInLastHour >= settings.perHour) {
    return `already asked for ${requestedInLastHour} wakeups in the last hour (cap ${settings.perHour}); try again later`;
  }
  if (live >= settings.livePerCreature) {
    return `already has ${live} wakeups waiting (cap ${settings.livePerCreature}); the keeper can cancel some`;
  }
  return undefined;
}

export const wakeLedgerWindowMs = hourMs;

const postureRank: Readonly<Record<ToolPosture, number>> = { "read-only": 0, write: 1, act: 2 };

type WakeTrigger = { trigger: Routine["trigger"] } | { problem: string };

function wakeTriggerOf(request: WakeRequest, now: number, settings: WakeSettings): WakeTrigger {
  const asked = [request.inMinutes, request.at, request.everyMinutes].filter(
    (value) => value !== undefined,
  );
  if (asked.length !== 1) return { problem: "name exactly one of in_minutes, at or every_minutes" };
  const horizon = now + settings.horizonMs;
  if (request.everyMinutes !== undefined) {
    if (request.everyMinutes < settings.everyFloorMinutes) {
      return { problem: `every_minutes is at least ${settings.everyFloorMinutes}` };
    }
    return {
      trigger: { kind: "interval", minutes: request.everyMinutes, until: isoOf(horizon) },
    };
  }
  if (request.at !== undefined && !isInstant(request.at)) {
    return { problem: "at is not a date-time with an offset" };
  }
  const instant =
    request.inMinutes !== undefined
      ? now + request.inMinutes * minuteMs
      : Date.parse(request.at ?? "");
  if (instant <= now) return { problem: "the wakeup must be in the future" };
  if (instant > horizon) {
    return { problem: `a wakeup is at most ${settings.horizonMs / dayMs} days away (RUN-048)` };
  }
  return { trigger: { kind: "at", at: isoOf(instant) } };
}

function firstLineOf(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
