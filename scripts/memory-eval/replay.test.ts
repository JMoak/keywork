import { spawnSync } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  builtinDecider,
  jevModel,
  type MemoryDecider,
  type MemoryDecision,
  memoryQuestions,
} from "../../packages/engine/src/index.ts";
import { scratchDirs } from "../../packages/shared/src/testing/index.ts";
import { repoRoot } from "../lib/repo-files.ts";
import { jevEdition, type LiveDeciders, openArm, typesafeKey } from "./arms.ts";
import {
  cassetteArm,
  cassettePath,
  readCassette,
  StaleCassetteError,
  writeCassette,
} from "./cassette.ts";
import {
  type AnswerLine,
  canonicalJson,
  type DecisionPoint,
  fixtureCorpusDir,
  readCorpus,
} from "./corpus.ts";
import { answersOf, keptOf } from "./metrics.ts";
import { builtinArm, builtinEdition, editionName, offArm, portArm, runArm } from "./replay.ts";
import { formatReport } from "./report.ts";
import { actionPoint, entryPoint, pairPoint } from "./test-corpus.ts";

const scratch = scratchDirs("keywork-memory-eval-replay-");
const fixture = join(repoRoot, fixtureCorpusDir);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the builtin arm", () => {
  it("reproduces the journaled injection of every harvested action point exactly", async () => {
    const corpus = await readCorpus(fixture);
    const answers = answersOf(await runArm(builtinArm(), corpus.points));
    const recorded = corpus.points.flatMap((point) =>
      point.question === memoryQuestions.actionRelevance && point.recorded !== undefined
        ? [point]
        : [],
    );
    expect(recorded.length).toBeGreaterThan(20);
    for (const point of recorded)
      expect(keptOf(answers.get(point.id))).toEqual(point.recorded?.kept);
  });

  it("answers every question the corpus asks, network-free", async () => {
    const corpus = await readCorpus(fixture);
    const answers = await runArm(builtinArm(), corpus.points);
    expect(answers.map((line) => line.decision.decider)).toEqual(
      corpus.points.map(() => "builtin"),
    );
    expect(answers.find((line) => line.question === memoryQuestions.pairRelation)?.outcome).toEqual(
      {
        relation: "unsure",
        confidence: 0,
      },
    );
  });

  it("matches the checked-in reference report", async () => {
    const corpus = await readCorpus(fixture);
    const answers = await runArm(builtinArm(), corpus.points);
    const markdown = formatReport({
      corpus,
      corpusName: fixtureCorpusDir,
      run: {
        record: {
          edition: builtinEdition,
          corpus: fixtureCorpusDir,
          corpusDigest: "",
          points: corpus.points.length,
          source: "rule",
        },
        answers,
      },
      builtin: answersOf(answers),
      off: answersOf(await runArm(offArm(), corpus.points)),
    });
    const checkedIn = await readFile(join(repoRoot, "docs", "memory-eval", "builtin-1.md"), "utf8");
    expect(withoutTimings(markdown)).toBe(withoutTimings(checkedIn));
  });
});

describe("the off arm", () => {
  it("is the floor: it keeps nothing, triages nothing and links nothing", async () => {
    const points: DecisionPoint[] = [actionPoint("a", ["A", "B"]), entryPoint("e"), pairPoint("p")];
    const answers = await runArm(offArm(), points);
    expect(answers.map((line) => line.outcome)).toEqual([
      { kept: [] },
      { durability: "unsure" },
      { relation: "unsure", confidence: 0 },
    ]);
  });
});

describe("portArm", () => {
  it("hands every question to its port method with the state the point holds", async () => {
    const seen: unknown[] = [];
    const builtin = builtinDecider();
    const listening: MemoryDecider = {
      ...builtin,
      id: "listening",
      chooseForAction: (input) => {
        seen.push(
          input.hits.map((hit) => [hit.note.name, hit.note.tokens, hit.legs]),
          [...input.surfaced],
        );
        return builtin.chooseForAction(input);
      },
      relatePair: (pair) => {
        seen.push([pair.a.name, pair.b.name, pair.similarity]);
        return builtin.relatePair(pair);
      },
    };
    const action = actionPoint("a", ["A", "B"], { surfaced: ["B"] });
    const arm = portArm({ decider: "listening", version: "1" }, listening);
    const [kept, related] = await runArm(arm, [action, pairPoint("p")]);
    expect(seen).toEqual([
      [
        ["A", 100, ["lexical"]],
        ["B", 100, ["lexical"]],
      ],
      ["B"],
      ["p older", "p newer", 0.5],
    ]);
    expect(kept?.outcome).toEqual({ kept: ["A"] });
    expect(related?.question).toBe(memoryQuestions.pairRelation);
  });
});

function scriptedJev(): MemoryDecider {
  const builtin = builtinDecider();
  return {
    ...builtin,
    id: "jev",
    chooseForAction: async (input) => {
      const decided = await builtin.chooseForAction(input);
      const scores = Object.fromEntries(
        input.hits.map((hit, index) => [hit.note.name, index === 0 ? 0.94 : 0.06]),
      );
      const kept = decided.outcome.slice(0, 1);
      const decision: MemoryDecision = {
        ...decided.decision,
        id: `jev-${input.action.callId}`,
        decider: "jev",
        model: "jev-1.13.0",
        scores,
        choice: { kept: kept.map((hit) => hit.note.name), dropped: [] },
        latencyMs: 212,
        waitedMs: 9,
        inputTokens: 1400,
      };
      return { outcome: kept, decision };
    },
  };
}

const live: LiveDeciders = { jev: () => scriptedJev() };

async function corpusCopy(): Promise<string> {
  const dir = await scratch();
  await cp(fixture, dir, { recursive: true });
  return dir;
}

describe("opening the jev arm", () => {
  it("skips cleanly with no cassette and no key, and says so", async () => {
    const dir = await corpusCopy();
    const opened = await openArm("jev", { corpusDir: dir, points: [], env: {} });
    expect(opened).toMatchObject({ kind: "skipped", edition: jevEdition });
    if (opened.kind === "skipped") {
      expect(opened.reason).toContain("jev-1.13.0.cassette.jsonl and no TypeSafe key");
    }
  });

  it("names its edition after the model the adapter pins", () => {
    expect(editionName(jevEdition)).toBe(jevModel);
  });

  it("records with a key through the registered adapter, which asks Jev every question", async () => {
    const dir = await corpusCopy();
    const corpus = await readCorpus(dir);
    const [point] = corpus.points;
    if (point === undefined) throw new Error("expected points");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 401 }));
    const opened = await openArm("jev", {
      corpusDir: dir,
      points: corpus.points,
      env: { TYPESAFE_API_KEY: "k" },
    });
    if (opened.kind !== "ready") throw new Error("expected a live arm");
    expect(opened).toMatchObject({ source: "live", cassette: cassettePath(dir, jevEdition) });

    const line = await opened.arm.answer(point);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(line.decision.fallback).toEqual({ reason: "refused" });
  });

  it("records live into the corpus's cassette, then replays it byte for byte", async () => {
    const dir = await corpusCopy();
    const corpus = await readCorpus(dir);
    const context = {
      corpusDir: dir,
      points: corpus.points,
      env: { KEYWORK_TYPESAFE_API_KEY: "k" },
      live,
    };
    const recording = await openArm("jev", context);
    if (recording.kind !== "ready" || recording.cassette === undefined)
      throw new Error("expected a live arm");
    expect(recording.source).toBe("live");
    await writeCassette(recording.cassette, await runArm(recording.arm, corpus.points));
    const cassette = await readFile(cassettePath(dir, jevEdition), "utf8");

    const replaying = await openArm("jev", { ...context, env: {} });
    if (replaying.kind !== "ready") throw new Error("expected the cassette to replay");
    expect(replaying.source).toBe("cassette");
    const first = await runArm(replaying.arm, corpus.points);
    const second = await runArm(replaying.arm, corpus.points);
    const bytes = (lines: AnswerLine[]) => lines.map((line) => `${canonicalJson(line)}\n`).join("");
    expect(bytes(first)).toBe(cassette);
    expect(bytes(second)).toBe(cassette);
  });

  it("refuses a stale cassette instead of replaying answers to questions the corpus no longer asks", async () => {
    const dir = await corpusCopy();
    const corpus = await readCorpus(dir);
    const recorded = await runArm(portArm(jevEdition, scriptedJev()), corpus.points.slice(1));
    await writeCassette(cassettePath(dir, jevEdition), recorded);
    const opened = await openArm("jev", { corpusDir: dir, points: corpus.points, env: {} });
    expect(opened).toMatchObject({
      kind: "skipped",
      reason: expect.stringContaining(
        `answers ${corpus.points.length - 1} of ${corpus.points.length}`,
      ),
    });
    const cassette = await readCassette(cassettePath(dir, jevEdition));
    if (cassette === undefined) throw new Error("expected a cassette");
    const [first] = corpus.points;
    if (first === undefined) throw new Error("expected points");
    await expect(cassetteArm(jevEdition, cassette).answer(first)).rejects.toThrow(
      StaleCassetteError,
    );
  });

  it("prefers the scoped key, then the ambient one, and ignores a blank", () => {
    expect(typesafeKey({ KEYWORK_TYPESAFE_API_KEY: "scoped", TYPESAFE_API_KEY: "ambient" })).toBe(
      "scoped",
    );
    expect(typesafeKey({ KEYWORK_TYPESAFE_API_KEY: " ", TYPESAFE_API_KEY: "ambient" })).toBe(
      "ambient",
    );
    expect(typesafeKey({})).toBeUndefined();
  });
});

describe("bun run memory:eval", () => {
  it("runs the jev arm with no cassette and no key to a clean skip, and reports why", async () => {
    const out = await scratch();
    const env = { ...process.env, TYPESAFE_API_KEY: "", KEYWORK_TYPESAFE_API_KEY: "" };
    const script = join(repoRoot, "scripts", "memory-eval.ts");
    const ran = spawnSync("bun", [script, "run", "--decider", "jev", "--out", out], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("jev-1.13.0 skipped: no cassette at");
    const reported = spawnSync("bun", [script, "report", "--run", out], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain("was not run, so it proves nothing. Skipped: no cassette at");
    expect(reported.stdout).toContain("| `action-relevance@1` |");
  });
});

function withoutTimings(markdown: string): string {
  return markdown.replace(/\d+ \/ \d+(?: \/ \d+)? ms/g, "timing");
}
