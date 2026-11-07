import { createHash } from "node:crypto";
import { minuteMs } from "./clock.ts";
import { nextCronSlot, parseCron } from "./cron.ts";
import {
  type CronTrigger,
  type IntervalTrigger,
  isCalendarDate,
  type Routine,
  type RoutineTrigger,
} from "./routine.ts";
import { addDays, instantOf } from "./zone.ts";

export interface SlotPlan {
  next(after: number): number | undefined;
}

export function routinePlanOf(routine: Routine, anchor: number): SlotPlan | undefined {
  const plan = slotPlanOf(routine.trigger, anchor);
  const expiry = wakeExpiryOf(routine);
  return plan === undefined || expiry === undefined ? plan : withFallbackWake(plan, expiry);
}

export function wakeExpiryOf(routine: Routine): number | undefined {
  const { trigger, wake } = routine;
  if (wake === undefined || trigger.kind !== "interval" || trigger.until === undefined) {
    return undefined;
  }
  return Date.parse(trigger.until);
}

export function slotPlanOf(trigger: RoutineTrigger, anchor: number): SlotPlan | undefined {
  switch (trigger.kind) {
    case "cron":
      return cronPlan(trigger);
    case "interval":
      return intervalPlan(trigger, anchor);
    case "at":
      return oncePlan(Date.parse(trigger.at));
    case "file-watch":
    case "webhook":
    case "event":
    case "manual":
      return undefined;
  }
}

export function hasSlots(trigger: RoutineTrigger): boolean {
  return slotPlanOf(trigger, 0) !== undefined;
}

export function slotsBetween(plan: SlotPlan, after: number, through: number): number[] {
  const slots: number[] = [];
  for (let slot = plan.next(after); slot !== undefined && slot <= through; slot = plan.next(slot)) {
    slots.push(slot);
  }
  return slots;
}

export function staggerOf(key: string, trigger: RoutineTrigger): number {
  if (trigger.kind === "at") return 0;
  const span = trigger.kind === "interval" ? Math.min(minuteMs, trigger.minutes * 6_000) : minuteMs;
  return stableNumberOf(key) % span;
}

function cronPlan(trigger: CronTrigger): SlotPlan {
  const schedule = parseCron(trigger.expr);
  const end = trigger.until === undefined ? undefined : untilInstant(trigger.until, trigger.tz);
  return {
    next: (after) => {
      const slot = nextCronSlot(schedule, trigger.tz, after);
      return slot !== undefined && (end === undefined || slot < end) ? slot : undefined;
    },
  };
}

function intervalPlan(trigger: IntervalTrigger, anchor: number): SlotPlan {
  const period = trigger.minutes * minuteMs;
  const end = trigger.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(trigger.until);
  return {
    next: (after) => {
      const slot =
        after < anchor
          ? anchor + period
          : anchor + (Math.floor((after - anchor) / period) + 1) * period;
      return slot <= end ? slot : undefined;
    },
  };
}

function oncePlan(instant: number): SlotPlan {
  return { next: (after) => (after < instant ? instant : undefined) };
}

function withFallbackWake(plan: SlotPlan, expiry: number): SlotPlan {
  return { next: (after) => plan.next(after) ?? (after < expiry ? expiry : undefined) };
}

function untilInstant(until: string, zone: string): number {
  if (!isCalendarDate(until)) return Date.parse(until) + 1;
  const [year, month, day] = until.split("-").map(Number) as [number, number, number];
  const following = addDays({ year, month, day }, 1);
  return instantOf({ ...following, hour: 0, minute: 0 }, zone);
}

function stableNumberOf(key: string): number {
  return createHash("sha256").update(key).digest().readUIntBE(0, 6);
}
