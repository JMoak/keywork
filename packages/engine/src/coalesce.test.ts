import { describe, expect, it } from "vitest";
import { type BusEvent, coalesceDeltas } from "./coalesce.ts";

function steppingClock() {
  const due: (() => void)[] = [];
  return {
    tick: (flush: () => void) => {
      due.push(flush);
    },
    step: () => {
      for (const flush of due.splice(0)) flush();
    },
    pending: () => due.length,
  };
}

function harness() {
  const clock = steppingClock();
  const out: BusEvent[] = [];
  const coalescer = coalesceDeltas((event) => out.push(event), clock.tick);
  return { clock, out, coalescer };
}

const text = (text: string): BusEvent => ({
  type: "turn.delta",
  payload: { delta: { type: "text", text } },
});
const thinking = (text: string): BusEvent => ({
  type: "turn.delta",
  payload: { delta: { type: "visible-thinking", text } },
});
const chunk = (callId: string, chunk: string): BusEvent => ({
  type: "tool.output",
  payload: { chunk, callId },
});

describe("coalesceDeltas", () => {
  it("merges same-target deltas within a tick into one event and holds them until the tick", () => {
    const { clock, out, coalescer } = harness();

    coalescer.push(text("a"));
    coalescer.push(text("b"));
    coalescer.push(chunk("c1", "1"));
    coalescer.push(chunk("c1", "2"));
    expect(out).toEqual([]);
    expect(clock.pending()).toBe(1);

    clock.step();

    expect(out).toEqual([text("ab"), chunk("c1", "12")]);
  });

  it("keeps order across targets, merging only runs of the same target", () => {
    const { clock, out, coalescer } = harness();

    coalescer.push(text("a"));
    coalescer.push(chunk("c1", "1"));
    coalescer.push(text("b"));
    coalescer.push(thinking("t"));
    coalescer.push(chunk("c2", "x"));
    coalescer.push(chunk("c1", "2"));
    clock.step();

    expect(out).toEqual([
      text("a"),
      chunk("c1", "1"),
      text("b"),
      thinking("t"),
      chunk("c2", "x"),
      chunk("c1", "2"),
    ]);
  });

  it("passes non-delta events through at once, flushing what came before them first", () => {
    const { clock, out, coalescer } = harness();
    const started: BusEvent = {
      type: "tool.started",
      payload: { call: { type: "tool-call", callId: "c1", name: "echo", arguments: {} } },
    };
    const done: BusEvent = {
      type: "turn.delta",
      payload: { delta: { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } },
    };

    coalescer.push(text("a"));
    coalescer.push(started);
    coalescer.push(text("b"));
    coalescer.push(done);

    expect(out).toEqual([text("a"), started, text("b"), done]);
    clock.step();
    expect(out).toHaveLength(4);
  });

  it("never waits past the tick and arms exactly one tick per batch", () => {
    const { clock, out, coalescer } = harness();

    coalescer.push(text("a"));
    coalescer.push(text("b"));
    expect(clock.pending()).toBe(1);
    clock.step();
    expect(out).toEqual([text("ab")]);
    expect(clock.pending()).toBe(0);

    coalescer.push(text("c"));
    expect(clock.pending()).toBe(1);
    clock.step();
    expect(out).toEqual([text("ab"), text("c")]);

    clock.step();
    expect(out).toHaveLength(2);
  });

  it("keeps replayed and live deltas apart and leaves the incoming payloads untouched", () => {
    const { clock, out, coalescer } = harness();
    const replayed: BusEvent = {
      type: "turn.delta",
      payload: { delta: { type: "text", text: "r" }, replay: true },
    };
    const live = text("l");

    coalescer.push(replayed);
    coalescer.push(replayed);
    coalescer.push(live);
    clock.step();

    expect(out).toEqual([
      { type: "turn.delta", payload: { delta: { type: "text", text: "rr" }, replay: true } },
      live,
    ]);
    expect(replayed.payload).toEqual({ delta: { type: "text", text: "r" }, replay: true });
  });

  it("flush() drains on demand", () => {
    const { out, coalescer } = harness();

    coalescer.push(chunk("c1", "1"));
    coalescer.flush();

    expect(out).toEqual([chunk("c1", "1")]);
  });
});
