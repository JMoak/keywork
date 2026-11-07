import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "../../messages.ts";
import type { Provider, TurnDelta } from "../../provider.ts";
import type { ServerFingerprint } from "../capabilities/index.ts";
import type { Decider, DecisionRequest } from "../decide/types.ts";
import {
  formatBenchReport,
  type LabelledDecision,
  readBenchTrace,
  readLabelledDecisions,
  runChatBench,
  runDecideBench,
  scoreTurn,
} from "./index.ts";

const fingerprint: ServerFingerprint = {
  id: "ollama@moak-main:11434",
  kind: "ollama",
  version: "0.40.14",
  build: null,
  routes: ["/api/version", "/api/show", "/api/ps"],
};

type ScriptedTurn =
  | { calls: ToolCallPart[]; text?: string; input: number; output: number }
  | "error";

function call(name: string, args: unknown): ToolCallPart {
  return {
    type: "tool-call",
    callId: `${name}-${JSON.stringify(args).length}`,
    name,
    arguments: args,
  };
}

const right = {
  readConfig: {
    calls: [call("read_file", { path: "packages/server/src/serve-options.ts" })],
    input: 900,
    output: 40,
  },
  runTests: { calls: [call("run_command", { command: "bun run test" })], input: 850, output: 30 },
  compare: {
    calls: [
      call("read_file", { path: "packages/engine/package.json" }),
      call("read_file", { path: "packages/cli/package.json" }),
    ],
    input: 1000,
    output: 60,
  },
  noTool: { calls: [], text: "You are welcome.", input: 1100, output: 20 },
};

const script: ScriptedTurn[] = [
  right.readConfig,
  right.runTests,
  right.compare,
  right.noTool,
  { ...right.readConfig, calls: [call("read_file", { path: "packages/server/src/serve.ts" })] },
  { ...right.runTests, calls: [call("run_command", { command: 42 })] },
  { ...right.compare, calls: [call("read_file", { path: "packages/engine/package.json" })] },
  { ...right.noTool, calls: [call("search_code", { query: "port" })] },
  { ...right.readConfig, calls: [call("read_file", "{broken")] },
  "error",
  right.compare,
  right.noTool,
];

function scriptedProvider(turns: readonly ScriptedTurn[]): Provider {
  const remaining = [...turns];
  return {
    name: "ollama",
    modelId: "qwen3.6-35b-a3b",
    stream: (): AsyncIterable<TurnDelta> => {
      const turn = remaining.shift();
      return (async function* () {
        if (turn === undefined || turn === "error") throw new Error("HTTP 503 saturated");
        if (turn.text !== undefined) yield { type: "text", text: turn.text };
        for (const made of turn.calls) yield { type: "tool-call", call: made };
        yield { type: "done", usage: { inputTokens: turn.input, outputTokens: turn.output } };
      })();
    },
  };
}

function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

async function chatReport() {
  return runChatBench({
    reference: "ollama/qwen3.6-35b-a3b",
    fingerprint,
    provider: scriptedProvider(script),
    trace: await readBenchTrace(),
    clock: steppingClock(500),
  });
}

describe("runChatBench on the replayed trace fixture", () => {
  it("reports mean and range over three repeats", async () => {
    const report = await chatReport();
    expect(report).toEqual({
      kind: "chat",
      reference: "ollama/qwen3.6-35b-a3b",
      fingerprint,
      trace: "keywork-core",
      repeats: 3,
      turns: 4,
      validAt1: { mean: expect.closeTo(2.5 / 3), min: 0.5, max: 1 },
      toolCalls: {
        name: { mean: 0.75, min: 0.5, max: 1 },
        schema: { mean: 0.75, min: 0.5, max: 1 },
        arguments: { mean: expect.closeTo(1.75 / 3), min: 0.25, max: 1 },
        noTool: { mean: expect.closeTo(2 / 3), min: 0, max: 1 },
        parallel: { mean: expect.closeTo(2 / 3), min: 0, max: 1 },
      },
      tokensPerTurn: { mean: expect.closeTo(11_120 / 11), min: 880, max: 1120 },
      secondsPerTurn: { mean: 0.5, min: 0.5, max: 0.5 },
      decodeTokensPerSecond: { mean: expect.closeTo(840 / 11), min: 40, max: 120 },
      fallbacks: 1,
    });
  });

  it("is stable: the same script and clock give the same report", async () => {
    expect(await chatReport()).toEqual(await chatReport());
  });

  it("formats the report for the terminal", async () => {
    expect(formatBenchReport(await chatReport())).toBe(
      [
        "bench ollama/qwen3.6-35b-a3b · trace keywork-core · 3 repeats of 4 turns",
        "server ollama 0.40.14 · fingerprint ollama@moak-main:11434",
        "  valid@1                   0.83 (0.50 to 1.00)",
        "  tool name                 0.75 (0.50 to 1.00)",
        "  tool schema               0.75 (0.50 to 1.00)",
        "  tool arguments            0.58 (0.25 to 1.00)",
        "  no tool when none         0.67 (0.00 to 1.00)",
        "  parallel calls            0.67 (0.00 to 1.00)",
        "  tokens per turn           1011 (880 to 1120)",
        "  seconds per turn          0.50",
        "  decode tok/s              76.4 (40.0 to 120.0)",
        "  fallbacks                 1",
        "",
      ].join("\n"),
    );
  });

  it("refuses fewer than three repeats", async () => {
    await expect(
      runChatBench({
        reference: "ollama/x",
        fingerprint,
        provider: scriptedProvider([]),
        trace: await readBenchTrace(),
        repeats: 2,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("scoreTurn", () => {
  it("holds a call to an undeclared tool invalid", async () => {
    const trace = await readBenchTrace();
    const [first] = trace.turns;
    if (first === undefined) throw new Error("the fixture has turns");
    const score = scoreTurn(first, trace.tools, [call("delete_file", { path: "x" })]);
    expect(score).toMatchObject({ valid: false, name: false, schema: false, arguments: false });
  });
});

function scriptedDecider(rows: readonly LabelledDecision[]): Decider {
  const asked = new Map<string, number>();
  const pYesOf = (row: LabelledDecision): number => {
    if (row.id === "clean-modules") return 0.3;
    if (row.id === "read-env") return 0.7;
    return row.label ? 0.9 : 0.1;
  };
  return {
    reference: { provider: "ollama", model: "nimble" },
    decide: async (request: DecisionRequest) => {
      const [id] = Object.keys(request.questions);
      const row = rows.find((candidate) => candidate.id === id);
      if (id === undefined || row === undefined) throw new Error("unknown row");
      const times = (asked.get(id) ?? 0) + 1;
      asked.set(id, times);
      if (id === "send-mail" && times === 3) {
        return { ok: false, failure: { reason: "saturated", status: 503, message: "busy" } };
      }
      const pYes = pYesOf(row);
      return {
        ok: true,
        model: "nimble",
        answers: { [id]: { type: "noul", pYes, confidence: Math.max(pYes, 1 - pYes) } },
        usage: { inputTokens: 300, questions: 1, cost: null },
        latencyMs: 100,
      };
    },
  };
}

describe("runDecideBench on the labelled fixture", () => {
  it("reports Brier, ECE, AUROC and the threshold at target precision", async () => {
    const rows = await readLabelledDecisions();
    const report = await runDecideBench({
      reference: "ollama/nimble",
      fingerprint,
      decider: scriptedDecider(rows),
      rows,
      clock: steppingClock(100),
    });
    expect(report).toEqual({
      kind: "decide",
      reference: "ollama/nimble",
      fingerprint,
      rows: 24,
      repeats: 3,
      validAt1: { mean: expect.closeTo((1 + 1 + 23 / 24) / 3), min: 23 / 24, max: 1 },
      brier: {
        mean: expect.closeTo((0.05 + 0.05 + 1.19 / 23) / 3),
        min: expect.closeTo(0.05),
        max: expect.closeTo(1.19 / 23),
      },
      ece: {
        mean: expect.closeTo((0.15 + 0.15 + 3.5 / 23) / 3),
        min: expect.closeTo(0.15),
        max: expect.closeTo(3.5 / 23),
      },
      auroc: {
        mean: expect.closeTo((143 / 144 + 143 / 144 + 131 / 132) / 3),
        min: expect.closeTo(131 / 132),
        max: expect.closeTo(143 / 144),
      },
      thresholdAtPrecision: {
        target: 0.95,
        threshold: 0.9,
        precision: 1,
        coverage: 33 / 71,
        n: 33,
      },
      secondsPerQuestion: { mean: expect.closeTo(0.1), min: 0.1, max: 0.1 },
      inputTokensPerQuestion: { mean: 300, min: 300, max: 300 },
      fallbacks: 1,
    });
    expect(formatBenchReport(report)).toContain(
      "  threshold                 0.90 for precision 1.00 at target 0.95, coverage 0.46 of 33",
    );
  });
});
