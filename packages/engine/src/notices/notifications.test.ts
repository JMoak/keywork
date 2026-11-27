import { describe, expect, it } from "vitest";
import { FakeClock } from "../routines/testing.ts";
import {
  keeperNotifications,
  memoryHeldSource,
  type NoticeInput,
  type NotificationEvent,
} from "./notifications.ts";
import { type Quiet, quietAt } from "./quiet.ts";
import { memorySettingsSource, notificationSettingsSchema } from "./settings.ts";
import { heldBy, type NoticeSubject, noticeTierOf } from "./tier.ts";

const at = (iso: string) => Date.parse(iso);
const settle = async () => undefined;

const nightOnly = {
  settings: notificationSettingsSchema.parse({
    quietHours: { start: "22:00", end: "07:00" },
    tz: "UTC",
  }),
  doNotDisturbSince: null,
};

describe("the tier of a thing that would notify", () => {
  const night = quietAt(at("2026-11-05T23:00:00Z"), nightOnly);
  const focus: Quiet = { reason: "do-not-disturb", since: "2026-11-05T14:00:00.000Z", until: null };
  const rows: [string, NoticeSubject, Quiet | null, string, boolean][] = [
    ["a question by day", { kind: "ask" }, null, "interrupt", false],
    ["a question in quiet hours", { kind: "ask" }, night, "interrupt", true],
    ["a question under do not disturb", { kind: "ask" }, focus, "interrupt", true],
    ["a failed chore run", { kind: "chore", need: "run", runHeld: true }, null, "interrupt", false],
    [
      "a chore turned off",
      { kind: "chore", need: "disabled", runHeld: false },
      null,
      "interrupt",
      false,
    ],
    [
      "a run parked on grants",
      { kind: "chore", need: "grants", runHeld: true },
      night,
      "interrupt",
      true,
    ],
    [
      "grants with no run held",
      { kind: "chore", need: "grants", runHeld: false },
      null,
      "digest",
      false,
    ],
    ["an always run", { kind: "run", notify: "always", needsKeeper: false }, null, "digest", false],
    [
      "an always run in quiet hours",
      { kind: "run", notify: "always", needsKeeper: false },
      night,
      "digest",
      true,
    ],
    [
      "a quiet run",
      { kind: "run", notify: "only-when-needs-me", needsKeeper: false },
      null,
      "log",
      false,
    ],
    ["a never run", { kind: "run", notify: "never", needsKeeper: false }, night, "log", false],
    [
      "a never run that needs you",
      { kind: "run", notify: "never", needsKeeper: true },
      null,
      "interrupt",
      false,
    ],
    ["the inbox at three", { kind: "inbox" }, night, "interrupt", true],
  ];

  it.each(rows)("%s", (_name, subject, quiet, tier, held) => {
    expect(noticeTierOf(subject)).toBe(tier);
    expect(heldBy(noticeTierOf(subject), quiet)).toBe(held);
  });
});

describe("quiet hours", () => {
  it("let a thing that can wait arrive at once as a note, hold everything while they last, and bring what waited in one digest when they end", async () => {
    const clock = new FakeClock(at("2026-11-05T21:00:00Z"));
    let digests = 0;
    const notifications = keeperNotifications({
      settings: memorySettingsSource(nightOnly),
      held: memoryHeldSource(),
      clock,
      newId: () => `d${++digests}`,
    });
    const events: NotificationEvent[] = [];
    notifications.subscribe((event) => events.push(event));

    const evening = notifications.notice(choreRun("r1", "2026-11-05T21:30:00.000Z"));
    expect(evening).toMatchObject({ tier: "digest", held: false });
    expect(notifications.state()).toMatchObject({
      held: [],
      digest: { id: "d1", reason: "arrived", notices: [evening] },
    });

    await clock.advanceTo(at("2026-11-05T23:10:00Z"), settle);
    const asked = notifications.notice(question("c7", "2026-11-05T23:10:00.000Z"));
    const another = notifications.notice(question("c8", "2026-11-05T23:20:00.000Z"));
    const night = notifications.notice(choreRun("r2", "2026-11-05T23:40:00.000Z"));
    notifications.resolved("ask:c8");
    expect(asked).toMatchObject({ tier: "interrupt", held: true });
    expect(another).toMatchObject({ tier: "interrupt", held: true });
    expect(night).toMatchObject({ tier: "digest", held: true });
    expect(notifications.state().held.map(({ id }) => id)).toEqual(["ask:c7", "run:r2"]);

    await clock.advanceTo(at("2026-11-06T07:30:00Z"), settle);
    expect(
      events.map(({ type, payload }) => [type, "change" in payload ? payload.change : ""]),
    ).toEqual([
      ["notifications.notice", ""],
      ["notifications.digest", "ready"],
      ["notifications.quiet", "began"],
      ["notifications.notice", ""],
      ["notifications.notice", ""],
      ["notifications.notice", ""],
      ["notifications.quiet", "ended"],
      ["notifications.digest", "ready"],
    ]);
    const { digest, held, quiet } = notifications.state();
    expect(quiet).toBeNull();
    expect(held).toEqual([]);
    expect(digest).toMatchObject({
      id: "d2",
      at: "2026-11-06T07:00:00.000Z",
      reason: "quiet-ended",
      folded: 0,
      seenAt: null,
    });
    expect(digest?.notices).toEqual([
      { ...asked, held: false },
      evening,
      { ...night, held: false },
    ]);
    expect(notifications.notice(question("c9", "2026-11-06T07:30:00.000Z"))).toMatchObject({
      held: false,
    });
    notifications.close();
  });
});

function question(callId: string, when: string): NoticeInput {
  return {
    id: `ask:${callId}`,
    subject: { kind: "ask" },
    creature: "pip",
    session: "s1",
    title: "Allow bash bun test?",
    at: when,
    about: { kind: "ask", callId, tool: "bash" },
  };
}

function choreRun(runId: string, when: string): NoticeInput {
  return {
    id: `run:${runId}`,
    subject: { kind: "run", notify: "always", needsKeeper: false },
    creature: "pip",
    session: null,
    title: 'Pip finished the chore "Tidy notes"',
    at: when,
    about: { kind: "run", routineId: "tidy-notes", runId },
  };
}
