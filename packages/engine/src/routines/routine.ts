import { createHash } from "node:crypto";
import { z } from "zod";
import { isVaultRelativePath } from "../memory/vault-files.ts";
import { isCron } from "./cron.ts";
import { isWorkspacePattern } from "./watch.ts";
import { isTimeZone } from "./zone.ts";

export const routineIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

const eventNamePattern = /^[a-z]+\.[a-z-]+$/;

export const toolPostures = ["read-only", "write", "act"] as const;

export const notifyChoices = ["always", "only-when-needs-me", "never"] as const;

const cronTrigger = z
  .object({
    kind: z.literal("cron"),
    expr: z
      .string()
      .refine(isCron, "not a five-field cron expression (minute hour day month weekday)")
      .describe("When the chore fires, in the five-field cron form the keeper already reads."),
    tz: z
      .string()
      .refine(isTimeZone, "not an IANA time zone")
      .describe("The IANA zone the expression is read in, so 9am stays 9am across DST (RUN-034)."),
    until: z
      .string()
      .refine(isUntil, "not a date (YYYY-MM-DD) or a date-time with an offset")
      .optional()
      .describe("The last day (inclusive, in tz) or instant the chore may fire (REQ-060)."),
  })
  .strict();

const intervalTrigger = z
  .object({
    kind: z.literal("interval"),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .describe("Minutes between runs, counted from when the node first indexed the chore."),
    until: z
      .string()
      .refine(isInstant, "not a date-time with an offset")
      .optional()
      .describe(
        "The instant after which the chore stops firing; a creature's paced wakeup expires so (RUN-048).",
      ),
  })
  .strict();

const atTrigger = z
  .object({
    kind: z.literal("at"),
    at: z
      .string()
      .refine(isInstant, "not a date-time with an offset")
      .describe(
        "The one instant the chore fires: a one-shot, the shape of a creature's own wakeup (REQ-057).",
      ),
  })
  .strict();

const fileWatchTrigger = z
  .object({
    kind: z.literal("file-watch"),
    paths: z
      .array(
        z.string().refine(isWorkspacePattern, "not a relative path or glob inside the workspace"),
      )
      .min(1)
      .max(16)
      .describe(
        "Paths or globs (*, **, ?) under the workspace root; nothing outside it is watched.",
      ),
    debounceMs: z
      .number()
      .int()
      .min(250)
      .max(10 * 60_000)
      .default(2_000)
      .describe("Changes inside this quiet window batch into one run (RUN-043)."),
  })
  .strict();

export const largestHookBytes = 1_048_576;

const webhookTrigger = z
  .object({
    kind: z.literal("webhook"),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(largestHookBytes)
      .default(65_536)
      .describe(
        "The largest body the hook takes; a larger one is refused and never reaches a run.",
      ),
  })
  .strict();

const eventTrigger = z
  .object({
    kind: z.literal("event"),
    name: z
      .string()
      .regex(eventNamePattern, "not a bus event name such as routine.finished")
      .describe(
        "The bus event that fires the chore, by exact name (for example routine.finished).",
      ),
    where: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({})
      .describe(
        "Payload fields, by dotted path, that must equal these values for the event to count.",
      ),
    debounceMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 60_000)
      .default(0)
      .describe(
        "Matching events inside this window batch into one run (RUN-043); 0 fires on each.",
      ),
  })
  .strict();

const manualTrigger = z.object({ kind: z.literal("manual") }).strict();

const wake = z
  .object({
    requestedAt: z
      .string()
      .refine(isInstant, "not a date-time with an offset")
      .describe("When the creature asked for this wakeup with the schedule tool."),
  })
  .strict();

const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation") }).strict(),
  z.object({ kind: z.literal("thread"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.string().refine(isVaultRelativePath, "not a relative path inside the workshop"),
    })
    .strict(),
]);

const grantRule = z
  .object({ action: z.string().trim().min(1), resource: z.string().trim().min(1) })
  .strict();

const budget = z
  .object({
    usd: z.number().positive().max(100),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
  })
  .strict();

export const routineSchema = z
  .object({
    id: z
      .string()
      .regex(
        routineIdPattern,
        "lowercase letters, digits and dashes, starting with a letter or digit",
      )
      .describe("The chore's name and its file name (routines/<id>.json)."),
    title: z.string().trim().min(1).describe("What the keeper sees on the chore board."),
    instructions: z
      .string()
      .trim()
      .min(1)
      .describe("The assignment the run is given; a stored assignment, never consent (RUN-033)."),
    trigger: z
      .discriminatedUnion("kind", [
        cronTrigger,
        intervalTrigger,
        atTrigger,
        fileWatchTrigger,
        webhookTrigger,
        eventTrigger,
        manualTrigger,
      ])
      .describe(
        "What starts a run: a time (cron, interval, at), an occurrence (file-watch, webhook, event) or the keeper (manual).",
      ),
    destination: destination
      .default({ kind: "conversation" })
      .describe("Where the finished output goes: the conversation, a named thread or a file."),
    notify: z
      .enum(notifyChoices)
      .default("only-when-needs-me")
      .describe("When the keeper hears about a run that does not need them (RUN-046)."),
    tools: z
      .enum(toolPostures)
      .default("read-only")
      .describe("The tool posture; write and act need the keeper to accept the grants once."),
    grants: z
      .array(grantRule)
      .default([])
      .describe("The grant set a write or act chore asks for; anything outside it asks."),
    budget: budget
      .default({ usd: 0.5, minutes: 10 })
      .describe("Per-run ceilings; exceeding either ends the run blocked with the reason."),
    enabled: z.boolean().default(true).describe("Whether the schedule fires at all."),
    wake: wake
      .optional()
      .describe(
        "Present when the creature asked for this chore itself (REQ-057); the keeper cancels it like any chore.",
      ),
  })
  .strict()
  .refine((routine) => routine.tools !== "read-only" || routine.grants.length === 0, {
    message: "a read-only chore declares no grants; set tools to write or act to ask for them",
    path: ["grants"],
  });

export const routineJsonSchema: Record<string, unknown> = z.toJSONSchema(routineSchema, {
  io: "input",
});

export type Routine = z.output<typeof routineSchema>;
export type RoutineInput = z.input<typeof routineSchema>;
export type RoutineTrigger = Routine["trigger"];
export type CronTrigger = Extract<RoutineTrigger, { kind: "cron" }>;
export type IntervalTrigger = Extract<RoutineTrigger, { kind: "interval" }>;
export type FileWatchTrigger = Extract<RoutineTrigger, { kind: "file-watch" }>;
export type EventTrigger = Extract<RoutineTrigger, { kind: "event" }>;
export type TriggerKind = RoutineTrigger["kind"];
export type ToolPosture = Routine["tools"];
export type GrantRule = Routine["grants"][number];
export type NotifyChoice = Routine["notify"];

export type RoutineParse = { routine: Routine } | { problem: string };

export function parseRoutine(value: unknown): RoutineParse {
  const parsed = routineSchema.safeParse(value);
  return parsed.success ? { routine: parsed.data } : { problem: z.prettifyError(parsed.error) };
}

export function grantDigest(routine: Pick<Routine, "tools" | "grants">): string {
  const grants = routine.grants
    .map(({ action, resource }) => `${action} ${resource}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${routine.tools}\n${grants}`).digest("hex").slice(0, 16);
}

export function needsAcceptance(routine: Pick<Routine, "tools">): boolean {
  return routine.tools !== "read-only";
}

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const offsetSuffixPattern = /(Z|[+-]\d{2}:\d{2})$/;

export function isCalendarDate(text: string): boolean {
  return calendarDatePattern.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

function isUntil(text: string): boolean {
  return isCalendarDate(text) || isInstant(text);
}

export function isInstant(text: string): boolean {
  return offsetSuffixPattern.test(text) && !Number.isNaN(Date.parse(text));
}
