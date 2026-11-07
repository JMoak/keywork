import { z } from "zod";
import { toolPostures } from "../routines/routine.ts";
import type { Missing, Refusal, ScheduledWake } from "../routines/service.ts";
import type { WakeRequest } from "../routines/wake.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";

export interface WakeScheduler {
  scheduleWake(creature: string, request: WakeRequest): Promise<ScheduledWake | Refusal | Missing>;
}

export interface ScheduleTarget {
  creature: string;
  wakes: WakeScheduler;
}

export function scheduleTool(target: ScheduleTarget): Tool {
  return defineTool({
    name: "schedule",
    description:
      "Ask to be woken later to continue on your own: once (in_minutes or at) or on a pace (every_minutes). The wakeup is a chore you own, on the keeper's chore board, which the keeper can cancel. It runs read-only unless you ask for write or act tools, and then only with grants the keeper already accepted for one of your chores; anything more parks until the keeper accepts it.",
    schema: scheduleArgs,
    run: async (args) =>
      sentenceOf(await target.wakes.scheduleWake(target.creature, requestOf(args))),
  });
}

const grantRule = z.object({ action: z.string().min(1), resource: z.string().min(1) }).strict();

const scheduleArgs = z
  .object({
    note: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("What to do when you wake: the instructions the wakeup runs with."),
    in_minutes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Wake once, this many minutes from now."),
    at: z
      .string()
      .optional()
      .describe(
        "Wake once at this ISO 8601 date-time, with its offset (for example 2026-11-06T15:00:00-06:00).",
      ),
    every_minutes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Wake on this pace until the wakeup expires; the node sets a floor."),
    tools: z.enum(toolPostures).optional().describe("read-only (the default), write or act."),
    grants: z
      .array(grantRule)
      .optional()
      .describe("The grant rules a write or act wakeup needs, as { action, resource }."),
  })
  .strict();

type ScheduleArgs = z.infer<typeof scheduleArgs>;

function requestOf(args: ScheduleArgs): WakeRequest {
  return {
    note: args.note,
    inMinutes: args.in_minutes,
    at: args.at,
    everyMinutes: args.every_minutes,
    tools: args.tools,
    grants: args.grants,
  };
}

function sentenceOf(outcome: ScheduledWake | Refusal | Missing): string {
  if (outcome === "missing-creature") return "Not scheduled: this session belongs to no creature.";
  if (outcome === "missing-routine") return "Not scheduled: the wakeup could not be written.";
  if ("refusal" in outcome) return `Not scheduled: ${outcome.refusal}.`;
  const { routine } = outcome;
  const when = routine.schedule.nextRunAt ?? "when the keeper runs it";
  const grants =
    routine.grants === null || !routine.grants.needsAcceptance
      ? "It runs read-only."
      : routine.grants.accepted
        ? `It runs with ${routine.grants.posture} tools under the grants you already hold (${outcome.inheritedFrom ?? "accepted"}).`
        : `It asks for ${routine.grants.posture} tools the keeper has not accepted, so it will park until they do.`;
  return `Scheduled ${routine.id}: next wake ${when}. ${grants} The keeper sees it on the chore board and can cancel it.`;
}
