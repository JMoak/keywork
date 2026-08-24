import { describe, expect, it } from "vitest";
import { Agent } from "../../packages/engine/src/index.ts";
import {
  defaultThresholds,
  formatReport,
  judgeSoak,
  percentile,
  type SoakSample,
} from "./budget.ts";
import { noteTool, replyMarker, SoakProvider } from "./provider.ts";

const megabyte = 1024 * 1024;

function sample(overrides: Partial<SoakSample> & { turn: number }): SoakSample {
  return {
    panes: 1,
    rssBytes: 200 * megabyte,
    heapBytes: 40 * megabyte,
    renderMs: 4,
    busesWithListeners: 1,
    ...overrides,
  };
}

const quiet = { busesWithListeners: 0, fatalGuardListeners: 0 };

describe("judgeSoak", () => {
  it("passes a flat run with no residue", () => {
    const verdict = judgeSoak([sample({ turn: 50 }), sample({ turn: 500 })], quiet);
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it("judges growth from the first post-warmup sample, not from a cold start", () => {
    const samples = [
      sample({ turn: 25, heapBytes: 10 * megabyte }),
      sample({ turn: 50, heapBytes: 40 * megabyte }),
      sample({ turn: 500, heapBytes: 42 * megabyte }),
    ];
    const verdict = judgeSoak(samples, quiet);
    expect(verdict.baseline?.turn).toBe(50);
    expect(verdict.ok).toBe(true);
  });

  it("fails heap growth past ratio plus slack, and rss past its ratio", () => {
    const samples = [
      sample({ turn: 50, heapBytes: 40 * megabyte, rssBytes: 200 * megabyte }),
      sample({ turn: 500, heapBytes: 70 * megabyte, rssBytes: 320 * megabyte }),
    ];
    const verdict = judgeSoak(samples, quiet);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join("\n")).toContain("heap grew");
    expect(verdict.findings.join("\n")).toContain("rss grew");
  });

  it("tolerates growth inside the slack on a small baseline", () => {
    const samples = [
      sample({ turn: 50, heapBytes: 4 * megabyte }),
      sample({ turn: 500, heapBytes: 10 * megabyte }),
    ];
    expect(judgeSoak(samples, quiet).ok).toBe(true);
  });

  it("fails dangling listeners during the run and after quit, and surviving fatal guards", () => {
    const during = judgeSoak(
      [sample({ turn: 50 }), sample({ turn: 500, busesWithListeners: 3 })],
      quiet,
    );
    expect(during.findings.join("\n")).toContain("3 agent buses still have listeners");
    const after = judgeSoak([sample({ turn: 50 }), sample({ turn: 500 })], {
      busesWithListeners: 2,
      fatalGuardListeners: 1,
    });
    expect(after.findings).toEqual([
      "2 agent buses kept listeners after quit",
      "1 fatal-guard process listeners survived quit",
    ]);
  });

  it("fails a render p95 above the ceiling", () => {
    const samples = Array.from({ length: 20 }, (_, index) =>
      sample({ turn: 50 + index * 25, renderMs: index >= 18 ? 400 : 4 }),
    );
    const verdict = judgeSoak(samples, quiet, { ...defaultThresholds, renderP95Ms: 50 });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join("\n")).toContain("render p95");
  });

  it("reports a table, the growth summary, and the outcome", () => {
    const samples = [sample({ turn: 50 }), sample({ turn: 500 })];
    const report = formatReport(judgeSoak(samples, quiet), samples);
    expect(report).toContain("turn panes");
    expect(report).toContain("heap 40.0 → 40.0 MB");
    expect(report.trim().endsWith("soak ok")).toBe(true);
  });
});

describe("percentile", () => {
  it("takes the nearest-rank percentile", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("SoakProvider", () => {
  it("numbers replies by conversation turn and interleaves a note tool call every N turns", async () => {
    const provider = new SoakProvider(2);
    const agent = new Agent({ provider, tools: [noteTool], permissions: () => "allow" });
    const replies: string[] = [];
    const toolCalls: string[] = [];
    agent.bus.on("tool.started", ({ call }) => toolCalls.push(call.callId));

    for (let turn = 1; turn <= 4; turn += 1) {
      const message = await agent.send(`ping ${turn}`);
      replies.push(message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
    }

    expect(
      replies.map((reply) => reply.startsWith(replyMarker(replies.indexOf(reply) + 1))),
    ).toEqual([true, true, true, true]);
    expect(toolCalls).toEqual(["soak-2", "soak-4"]);
    expect(provider.turnsServed()).toBe(4);
  });
});
