import { describe, expect, it } from "vitest";
import { minuteMs } from "./clock.ts";
import { CronSyntaxError, nextCronSlot, parseCron } from "./cron.ts";
import { slotPlanOf, slotsBetween, staggerOf } from "./trigger.ts";
import { formatWallClock, instantOf } from "./zone.ts";

const chicago = "America/Chicago";

function next(expr: string, after: string, zone = "UTC"): string | undefined {
  const slot = nextCronSlot(parseCron(expr), zone, Date.parse(after));
  return slot === undefined ? undefined : new Date(slot).toISOString();
}

describe("parseCron", () => {
  it("reads lists, ranges, steps, names and macros", () => {
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    expect(parseCron("0 12 * jan-mar mon,WED").months).toEqual(new Set([1, 2, 3]));
    expect(parseCron("0 12 * jan-mar mon,WED").weekdays).toEqual(new Set([1, 3]));
    expect(parseCron("0 0 * * 7").weekdays).toEqual(new Set([0]));
    expect(parseCron("@hourly")).toEqual(parseCron("0 * * * *"));
  });

  it("ORs the day fields only when both are restricted", () => {
    expect(parseCron("0 0 13 * 5").dayRule).toBe("either");
    expect(parseCron("0 0 * * 5").dayRule).toBe("both");
    expect(parseCron("0 0 */2 * 5").dayRule).toBe("both");
  });

  it.each([
    ["0 9 * *", "five fields"],
    ["60 * * * *", "minute"],
    ["0 5-1 * * *", "backward"],
    ["*/0 * * * *", "step"],
    ["0 0 * smarch *", "month"],
    ["1/2/3 * * * *", "more than one step"],
  ])("refuses %s", (expr, detail) => {
    expect(() => parseCron(expr)).toThrow(CronSyntaxError);
    expect(() => parseCron(expr)).toThrow(detail);
  });
});

describe("nextCronSlot", () => {
  it("walks weekday mornings in the routine's zone", () => {
    expect(next("0 9 * * 1-5", "2026-11-05T12:00:00Z", chicago)).toBe("2026-11-05T15:00:00.000Z");
    expect(next("0 9 * * 1-5", "2026-11-05T15:00:00Z", chicago)).toBe("2026-11-06T15:00:00.000Z");
    expect(next("0 9 * * 1-5", "2026-11-06T15:00:00Z", chicago)).toBe("2026-11-09T15:00:00.000Z");
  });

  it("is strictly after the instant, at whole minutes", () => {
    expect(next("*/15 * * * *", "2026-11-05T10:07:30Z")).toBe("2026-11-05T10:15:00.000Z");
    expect(next("*/15 * * * *", "2026-11-05T10:15:00Z")).toBe("2026-11-05T10:30:00.000Z");
  });

  it("fires a slot that falls in the spring-forward gap right after the gap", () => {
    expect(next("30 2 * * *", "2026-03-07T12:00:00Z", chicago)).toBe("2026-03-08T08:30:00.000Z");
    expect(next("30 2 * * *", "2026-03-08T08:30:00Z", chicago)).toBe("2026-03-09T07:30:00.000Z");
  });

  it("fires a slot in the repeated fall-back hour once, at its first occurrence", () => {
    expect(next("30 1 * * *", "2026-10-31T12:00:00Z", chicago)).toBe("2026-11-01T06:30:00.000Z");
    expect(next("30 1 * * *", "2026-11-01T06:30:00Z", chicago)).toBe("2026-11-02T07:30:00.000Z");
  });

  it("treats both restricted day fields as either one matching", () => {
    expect(next("0 0 13 * 5", "2026-11-05T00:00:00Z")).toBe("2026-11-06T00:00:00.000Z");
    expect(next("0 0 13 * 5", "2026-11-06T00:00:00Z")).toBe("2026-11-13T00:00:00.000Z");
    expect(next("0 0 13 * 5", "2026-11-13T00:00:00Z")).toBe("2026-11-20T00:00:00.000Z");
  });

  it("finds a leap day years ahead", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("zones", () => {
  it("maps a wall clock to an instant and back", () => {
    const instant = instantOf({ year: 2026, month: 7, day: 4, hour: 9, minute: 0 }, chicago);
    expect(new Date(instant).toISOString()).toBe("2026-07-04T14:00:00.000Z");
    expect(formatWallClock(instant, chicago)).toBe("2026-07-04 09:00 America/Chicago");
  });
});

describe("slot plans", () => {
  const anchor = Date.parse("2026-11-05T10:00:00Z");

  it("counts interval slots from the anchor", () => {
    const plan = slotPlanOf({ kind: "interval", minutes: 40 }, anchor);
    expect(plan?.next(anchor - 1)).toBe(anchor + 40 * minuteMs);
    expect(plan?.next(anchor)).toBe(anchor + 40 * minuteMs);
    expect(plan?.next(anchor + 41 * minuteMs)).toBe(anchor + 80 * minuteMs);
  });

  it("stops a cron plan after its until date, read in the routine's zone", () => {
    const plan = slotPlanOf(
      { kind: "cron", expr: "0 23 * * *", tz: chicago, until: "2026-11-06" },
      anchor,
    );
    const lastDay = Date.parse("2026-11-07T05:00:00Z");
    expect(plan?.next(Date.parse("2026-11-06T12:00:00Z"))).toBe(lastDay);
    expect(plan?.next(lastDay)).toBeUndefined();
  });

  it("stops at an until instant with an offset", () => {
    const plan = slotPlanOf(
      { kind: "cron", expr: "0 * * * *", tz: "UTC", until: "2026-11-05T12:00:00Z" },
      anchor,
    );
    expect(plan?.next(Date.parse("2026-11-05T11:30:00Z"))).toBe(Date.parse("2026-11-05T12:00:00Z"));
    expect(plan?.next(Date.parse("2026-11-05T12:00:00Z"))).toBeUndefined();
  });

  it("has no slots for a manual trigger", () => {
    expect(slotPlanOf({ kind: "manual" }, anchor)).toBeUndefined();
  });

  it("lists the slots between two instants", () => {
    const plan = slotPlanOf({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, anchor);
    const slots = plan === undefined ? [] : slotsBetween(plan, anchor, anchor + 3 * 60 * minuteMs);
    expect(slots.map((slot) => new Date(slot).toISOString())).toEqual([
      "2026-11-05T11:00:00.000Z",
      "2026-11-05T12:00:00.000Z",
      "2026-11-05T13:00:00.000Z",
    ]);
  });

  it("staggers each routine deterministically within a minute or a tenth of its interval", () => {
    const cron = { kind: "cron", expr: "0 9 * * *", tz: "UTC" } as const;
    expect(staggerOf("wren/triage", cron)).toBe(staggerOf("wren/triage", cron));
    expect(staggerOf("wren/triage", cron)).not.toBe(staggerOf("wren/digest", cron));
    for (const key of ["a/b", "c/d", "e/f", "g/h"]) {
      expect(staggerOf(key, cron)).toBeLessThan(minuteMs);
      expect(staggerOf(key, { kind: "interval", minutes: 2 })).toBeLessThan(12_000);
    }
  });
});
