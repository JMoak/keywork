import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../providers/transport.ts";
import { builtinDecider } from "./builtin-decider.ts";
import { type JevAsk, jevClient, jevModel } from "./jev.ts";
import { jevDecider, withFallback } from "./jev-decider.ts";
import type { Note } from "./notes.ts";
import type { LegRanks, SearchHit } from "./search.ts";

interface CassetteEntry {
  name: string;
  request: { method: string; path: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

const cassette: CassetteEntry[] = readFileSync(
  fileURLToPath(new URL("./fixtures/jev-wire.cassette.jsonl", import.meta.url)),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function recorded(name: string): CassetteEntry {
  const entry = cassette.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no cassette entry named ${name}`);
  return entry;
}

function replaying(entry: CassetteEntry, sent: string[]): FetchLike {
  return async (url, init) => {
    expect(new URL(url).pathname).toBe(entry.request.path);
    expect(init?.method).toBe(entry.request.method);
    sent.push(String(init?.body));
    return new Response(JSON.stringify(entry.response.body), {
      status: entry.response.status,
      headers: entry.response.headers,
    });
  };
}

function onTrialOver(fetchFn: FetchLike) {
  const client = jevClient({ key: "ts-cassette-key", fetchFn });
  return withFallback(jevDecider({ client, trial: true }), builtinDecider());
}

function noteOf(name: string, body: string, created?: string): Note {
  return {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent",
    pinned: false,
    aliases: [],
    body,
    links: [],
    tokens: 30,
    frontmatter: {},
    ...(created !== undefined && { created }),
  };
}

function hitOf(note: Note, ranks: LegRanks): SearchHit {
  return { note, score: 1, legs: [], ranks, superseded: false, relations: { contradicts: [] } };
}

describe("the Jev wire cassette", () => {
  it("reads TypeSafe's documented noul answer exactly as published", async () => {
    const entry = recorded("vendor-noul-example");
    const ask: JevAsk = {
      state: { message: "Help! My payouts have been failing for 3 days." },
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this convey urgency?",
          criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
        },
      },
      pace: "sweep",
    };
    const reply = await jevClient({ key: "k", fetchFn: replaying(entry, []) }).ask(ask);
    expect(reply).toMatchObject({
      ok: true,
      model: jevModel,
      inputTokens: 296,
      answers: { is_urgent: { type: "noul", noul: 0.95 } },
    });
  });

  it("sends the recorded action-relevance request byte for byte and decides from its answer", async () => {
    const entry = recorded("action-relevance@1");
    const sent: string[] = [];
    const decided = await onTrialOver(replaying(entry, sent)).chooseForAction({
      action: {
        callId: "call-cassette",
        tool: "edit",
        subject: "src/auth/token.ts",
        subjectKind: "path",
      },
      hits: [
        hitOf(
          noteOf(
            "Auth Tokens",
            "Tokens rotate hourly; never cache them in memory.\n\nRotation lives in src/auth/rotate.ts.\n",
          ),
          { lexical: 1 },
        ),
        hitOf(noteOf("Release Checklist", "Tag, build, publish, announce.\n"), { lexical: 2 }),
        hitOf(noteOf("Dock Layout", "The dock keeps a 70/30 split.\n"), { semantic: 1 }),
      ],
      surfaced: new Set(),
      budget: { tokens: 1024, notes: 3 },
    });

    expect(sent).toEqual([JSON.stringify(entry.request.body)]);
    expect(decided.decision).toMatchObject({
      choice: { kept: ["Auth Tokens", "Dock Layout"], dropped: ["Release Checklist"] },
      scores: { "Auth Tokens": 0.94, "Release Checklist": 0.04, "Dock Layout": 0.52 },
      decider: "jev",
      model: jevModel,
      inputTokens: 1287,
      rule: "[[Dock Layout]] is near the path in meaning",
      fallback: { reason: "undecided", undecided: ["Dock Layout"] },
    });
  });

  it("sends the recorded pair-relation request byte for byte and acts on its answer", async () => {
    const entry = recorded("pair-relation@1");
    const sent: string[] = [];
    const decided = await onTrialOver(replaying(entry, sent)).relatePair({
      a: noteOf("Test Runner", "Tests run on node through vitest.\n", "2026-03-02"),
      b: noteOf(
        "Test Runner Bun",
        "Tests run on bun now; vitest stays the runner.\n",
        "2026-09-20",
      ),
      similarity: 0.44,
    });

    expect(sent).toEqual([JSON.stringify(entry.request.body)]);
    expect(decided.outcome).toEqual({
      relation: "newer-supersedes-older",
      confidence: 0.97,
      band: "act",
    });
    expect(decided.decision).toMatchObject({ confidence: 0.93, inputTokens: 842 });
  });
});
