import { describe, expect, it } from "vitest";
import { stillSilent } from "../promises/book.ts";
import type { StoppedChore } from "../promises/chores.ts";
import type { ModelEpisode } from "../promises/models.ts";
import { type QuestionFacts, questionsOf } from "../promises/questions.ts";
import { acceptanceAsked } from "../routines/service.ts";
import {
  askNoticeTitle,
  choreNeedNoticeTitle,
  choreRunNoticeTitle,
  inboxNoticeTitle,
} from "./titles.ts";

const asks = (tool: string, args: unknown, who: string | null = "Osk") =>
  askNoticeTitle({ who, tool, arguments: args });

const chore = (
  need: "grants" | "run" | "invalid",
  reason: string,
  run: {
    process: "blocked" | "failed" | "completed";
    delivery: "none" | "unknown";
    reason: string | null;
  } | null = null,
) =>
  choreNeedNoticeTitle({
    who: "Osk",
    chore: need === "invalid" ? null : "Tidy notes",
    routineId: "tidy-notes",
    need,
    reason,
    run,
  });

const silentMill = { provider: "mill", model: "puppet:7b" };

const millAddress = "http://127.0.0.1:11434";

const morningLook = (byCheck = false): StoppedChore => ({
  routineId: "morning-look",
  title: "Morning look",
  reason: byCheck
    ? "its check `test -f inbox/new` failed: it did not finish within 60 s, so it was stopped"
    : `the run could not start: mill does not answer at ${millAddress}; is its model server running?`,
  since: "2026-11-05T09:07:30.000Z",
  byCheck,
});

const talkFailed: ModelEpisode = {
  creature: "una",
  reference: silentMill,
  endpoint: millAddress,
  subject: "mill/puppet:7b",
  startedAt: "2026-11-05T09:00:00.000Z",
  tries: 3,
  bound: 3,
  nextAt: null,
  endedAt: "2026-11-05T09:03:30.000Z",
  outcome: "failed",
};

const asked = (facts: Partial<QuestionFacts>): string =>
  questionsOf({
    creature: "una",
    name: "Una",
    stopped: [],
    silentTalk: [],
    choreModel: undefined,
    findingOf: (reference) => ({
      reference,
      endpoint: millAddress,
      at: "2026-11-05T09:07:30.000Z",
      answered: false,
      found: `does not answer at ${millAddress}`,
    }),
    usable: () => [],
    ...facts,
  })
    .map(({ sentence }) => sentence)
    .join(" | ");

const titles: [string, string, string][] = [
  ["a write", asks("write", { path: "notes.md", content: "hi" }), "Osk asks to write notes.md"],
  [
    "an edit",
    asks("edit", { path: "barn/hay.md", oldText: "a", newText: "b" }),
    "Osk asks to edit barn/hay.md",
  ],
  ["a command", asks("bash", { command: "bun test" }), "Osk asks to run bun test"],
  [
    "a served tool",
    asks("github__create_issue", { repo: "keeper/garden", title: "Broken build" }),
    "Osk asks to use create_issue from github on keeper/garden",
  ],
  [
    "a conversation of no creature",
    asks("write", { path: "notes.md", content: "hi" }, null),
    "A conversation asks to write notes.md",
  ],
  [
    "a chore waiting on its grants",
    chore("grants", acceptanceAsked({ tools: "write", check: undefined })),
    'Osk\'s chore "Tidy notes" asks to write files',
  ],
  [
    "a chore waiting on its grants and its check",
    chore(
      "grants",
      acceptanceAsked({
        tools: "act",
        check: { command: "test -f build/failed", timeoutSeconds: 60 },
      }),
    ),
    'Osk\'s chore "Tidy notes" asks to run commands and write files, and to check for work by running test -f build/failed',
  ],
  [
    "a run over budget",
    chore("run", "ran past its 10-minute budget", {
      process: "blocked",
      delivery: "none",
      reason: "ran past its 10-minute budget",
    }),
    'Osk\'s chore "Tidy notes" stopped because it ran past its 10-minute budget',
  ],
  [
    "a run by hand that failed",
    chore("run", "the turn was interrupted", {
      process: "failed",
      delivery: "none",
      reason: "the turn was interrupted",
    }),
    'Osk\'s chore "Tidy notes" failed: the turn was interrupted',
  ],
  [
    "a run whose report may not have arrived",
    chore("run", "completed", { process: "completed", delivery: "unknown", reason: null }),
    'Osk\'s chore "Tidy notes" finished, but its report may not have arrived',
  ],
  [
    "a chore file that does not parse",
    chore("invalid", "✖ Invalid input: expected string → at title"),
    "Osk's chore file tidy-notes.json has a mistake, so the chore cannot run",
  ],
  [
    "a run that finished needing nobody",
    choreRunNoticeTitle({ who: "Osk", chore: "Tidy notes" }),
    'Osk finished the chore "Tidy notes"',
  ],
  ["the memory inbox", inboxNoticeTitle(3), "3 things in memory wait for your review"],
  [
    "a question about a silent model for talking",
    asked({ silentTalk: [talkFailed] }),
    "Una's model is not answering. Is its server running?",
  ],
  [
    "a question about a silent model for a chore",
    asked({ stopped: [morningLook()], choreModel: silentMill }),
    '"Morning look" did not run: Una\'s model is not answering.',
  ],
  [
    "a question about a silent model for talking and a chore",
    asked({ silentTalk: [talkFailed], stopped: [morningLook()], choreModel: silentMill }),
    'Una\'s model is not answering, so "Morning look" did not run. Is its server running?',
  ],
  [
    "a question about a chore that kept failing",
    asked({ stopped: [morningLook()] }),
    'Una\'s chore "Morning look" kept failing, so it stopped. Try it again?',
  ],
  [
    "a question about a chore whose check kept failing",
    asked({ stopped: [morningLook(true)] }),
    'Una\'s chore "Morning look" stopped: its check kept failing. Try it again?',
  ],
  ["trying again while the model is still silent", stillSilent, "Still no answer."],
];

const identifier =
  /\b[0-9a-f]{8,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-|\b(?:ask|chore|run|question):\S|call-\d/i;

const engineWord =
  /grant set|digest|\bcalls?\b|session|routine|posture|\bslug|\bbash\b|\btools?\b|thread|callId|runId|notice/i;

const modelOrAddress = /https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[\w.-]+\/[\w.-]+:[\w.-]+/;

describe("notice titles", () => {
  it("say who wants what in the keeper's words, with no identifier, engine word, model or address", () => {
    const said = titles.map(([what, title]) => [what, title]);
    expect(said).toEqual(titles.map(([what, , expected]) => [what, expected]));
    const unfit = titles.filter(
      ([, title]) => identifier.test(title) || engineWord.test(title) || modelOrAddress.test(title),
    );
    expect(unfit.map(([what, title]) => `${what}: ${title}`)).toEqual([]);
  });
});
