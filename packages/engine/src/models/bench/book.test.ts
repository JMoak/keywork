import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider, TurnDelta } from "../../provider.ts";
import type { ServerFingerprint } from "../capabilities/index.ts";
import type { Decider } from "../decide/types.ts";
import {
  type BenchOpener,
  type BenchReport,
  benchBook,
  modelBenchDir,
  readLabelledDecisions,
} from "./index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function benchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "keywork-bench-"));
  directories.push(directory);
  return modelBenchDir(directory);
}

const fingerprint: ServerFingerprint = {
  id: "ollama@127.0.0.1:11434",
  kind: "ollama",
  version: "0.40.14",
  build: null,
  routes: ["/api/version"],
};

const target = { endpoint: "http://127.0.0.1:11434", model: "qwen3.8:27b" };

function quietProvider(): Provider {
  return {
    name: "ollama",
    modelId: "qwen3.8:27b",
    stream: (): AsyncIterable<TurnDelta> =>
      (async function* () {
        yield { type: "text", text: "done" };
        yield { type: "done", usage: { inputTokens: 900, outputTokens: 50 } };
      })(),
  };
}

function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

function chatOpener(seen: BenchReport[] = []): BenchOpener {
  return async () => ({
    ok: true,
    reference: "ollama/qwen3.8:27b",
    fingerprint,
    subject: { kind: "chat", provider: quietProvider() },
    measured: (report) => void seen.push(report),
  });
}

const now = () => new Date("2026-11-05T12:00:00.000Z");

describe("benchBook", () => {
  it("runs the chat bench, reports it, measures it and keeps it as the last", async () => {
    const measured: BenchReport[] = [];
    const book = benchBook({ openers: [chatOpener(measured)], clock: steppingClock(500), now });
    const outcome = await book.run(target);
    if (!("report" in outcome)) throw new Error(outcome.error);
    expect(outcome.report).toMatchObject({
      kind: "chat",
      reference: "ollama/qwen3.8:27b",
      fingerprint,
      repeats: 3,
      decodeTokensPerSecond: { mean: 100, min: 100, max: 100 },
    });
    expect(measured).toEqual([outcome.report]);
    expect(await book.last(target)).toEqual(outcome.report);
    expect(await book.last({ ...target, endpoint: "http://127.0.0.1:11434/v1/" })).toEqual(
      outcome.report,
    );
    expect(await book.last({ ...target, model: "nimble:latest" })).toBeNull();
  });

  it("keeps the last report on disk for a later book", async () => {
    const dir = benchDir();
    const first = await benchBook({ openers: [chatOpener()], dir, now }).run(target);
    const reopened = benchBook({ openers: [], dir });
    expect(await reopened.last(target)).toEqual("report" in first ? first.report : undefined);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("reads a damaged report as none", async () => {
    const dir = benchDir();
    await benchBook({ openers: [chatOpener()], dir, now }).run(target);
    const [file = ""] = readdirSync(dir);
    writeFileSync(join(dir, file), JSON.stringify({ endpoint: target.endpoint, report: {} }));
    expect(await benchBook({ openers: [], dir }).last(target)).toBeNull();
  });

  it("refuses a second bench of the same model while one runs", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowOpener: BenchOpener = async (opened) => {
      await gate;
      return chatOpener()(opened);
    };
    const book = benchBook({ openers: [slowOpener] });
    const first = book.run(target);
    expect(await book.run({ ...target, endpoint: `${target.endpoint}/v1` })).toEqual({
      refused: "busy",
      error: "qwen3.8:27b is already on the bench",
    });
    release();
    expect(await first).toHaveProperty("report");
    expect(await book.run(target)).toHaveProperty("report");
  });

  it("asks each opener in turn and refuses what none claims", async () => {
    const declined: BenchOpener = async () => undefined;
    const refusing: BenchOpener = async () => ({
      ok: false,
      refused: "unreachable",
      error: "connect ECONNREFUSED",
    });
    expect(await benchBook({ openers: [declined] }).run(target)).toEqual({
      refused: "unrecognized",
      error: "nothing on this node knows how to bench http://127.0.0.1:11434",
    });
    expect(await benchBook({ openers: [declined, refusing, chatOpener()] }).run(target)).toEqual({
      refused: "unreachable",
      error: "connect ECONNREFUSED",
    });
  });

  it("reports a bench that cannot start as failed and keeps nothing", async () => {
    const book = benchBook({
      openers: [chatOpener()],
      trace: async () => {
        throw new Error("trace.json is unreadable");
      },
    });
    expect(await book.run(target)).toEqual({
      refused: "failed",
      error: "trace.json is unreadable",
    });
    expect(await book.last(target)).toBeNull();
  });

  it("runs the decide bench for a decision subject", async () => {
    const decider: Decider = {
      reference: { provider: "openrouter", model: "typesafe/jev-1.14" },
      decide: async (request) => ({
        ok: true,
        model: "typesafe/jev-1.14",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", pYes: 0.9, confidence: 0.9 } as const,
          ]),
        ),
        usage: { inputTokens: 120, questions: 1, cost: null },
        latencyMs: 40,
      }),
    };
    const rows = await readLabelledDecisions();
    const book = benchBook({
      openers: [
        async () => ({
          ok: true,
          reference: "openrouter/typesafe/jev-1.14",
          fingerprint: { ...fingerprint, id: "declared:openrouter", kind: "openrouter" },
          subject: { kind: "decide", decider },
        }),
      ],
      labelled: async () => rows,
    });
    const outcome = await book.run({
      endpoint: "https://openrouter.ai/api/v1",
      model: "typesafe/jev-1.14",
    });
    expect(outcome).toMatchObject({ report: { kind: "decide", rows: rows.length, repeats: 3 } });
  });
});
