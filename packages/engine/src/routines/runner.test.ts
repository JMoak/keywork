import { describe, expect, it } from "vitest";
import { parseRoutine, type Routine } from "./routine.ts";
import type { RunRequest, RunSignals, ThreadHost, ThreadSignal } from "./runner.ts";
import { threadRunner } from "./runner.ts";
import { routineInput } from "./testing.ts";

function fakeHost(promptOutcome: "started" | "missing" = "started") {
  const listeners = new Map<string, (signal: ThreadSignal) => void>();
  const calls: string[] = [];
  const host: ThreadHost = {
    openThread: async (thread) => {
      calls.push(`open ${thread.creature} as ${thread.bot}, ${thread.kind} "${thread.title}"`);
      return "session-1";
    },
    confine: async (sessionId, posture, grants) => {
      calls.push(`confine ${sessionId} ${posture} with ${grants.length} grants`);
    },
    prompt: async (sessionId) => {
      calls.push(`prompt ${sessionId}`);
      return promptOutcome;
    },
    abort: async (sessionId) => {
      calls.push(`abort ${sessionId}`);
      listeners.get(sessionId)?.({ kind: "turn-interrupted", text: "half done" });
    },
    denyAsk: async (callId) => {
      calls.push(`deny ${callId}`);
    },
    watch: (sessionId, listener) => {
      listeners.set(sessionId, listener);
      return () => listeners.delete(sessionId);
    },
  };
  const signal = (event: ThreadSignal) => listeners.get("session-1")?.(event);
  return { host, calls, signal, watching: () => listeners.size };
}

function recordingSignals() {
  const seen: string[] = [];
  const signals: RunSignals = {
    spent: (usd) => seen.push(`spent ${usd}`),
    asked: ({ callId, tool }) => seen.push(`asked ${callId} ${tool}`),
    answered: (callId, verdict) => seen.push(`answered ${callId} ${verdict}`),
  };
  return { seen, signals };
}

const routine = (parseRoutine(routineInput()) as { routine: Routine }).routine;

const request: RunRequest = {
  runId: "run-1",
  creature: { slug: "wren", dir: "/bots/wren", bot: "wren" },
  routine,
  prompt: "Read the inbox.",
  posture: "read-only",
  grants: [],
};

describe("threadRunner", () => {
  it("opens a routine thread as the creature's bot and confines it before the prompt", async () => {
    const fake = fakeHost();
    await threadRunner(fake.host).start(request, recordingSignals().signals);
    expect(fake.calls).toEqual([
      'open wren as wren, routine "Morning triage"',
      "confine session-1 read-only with 0 grants",
      "prompt session-1",
    ]);
  });

  it("finishes on the completed turn with its text, usage and cost", async () => {
    const fake = fakeHost();
    const { seen, signals } = recordingSignals();
    const handle = await threadRunner(fake.host).start(request, signals);
    fake.signal({ kind: "ask", callId: "call-1", tool: "bash" });
    fake.signal({ kind: "answered", callId: "call-1", verdict: "denied" });
    fake.signal({ kind: "spend", costUsd: 0.01 });
    fake.signal({
      kind: "turn-completed",
      text: "All quiet.",
      usage: { inputTokens: 10, outputTokens: 2 },
      costUsd: 0.03,
    });
    expect(await handle.finished).toEqual({
      ended: "completed",
      output: "All quiet.",
      usage: { inputTokens: 10, outputTokens: 2 },
      costUsd: 0.03,
      reason: null,
    });
    expect(seen).toEqual([
      "asked call-1 bash",
      "answered call-1 denied",
      "spent 0.01",
      "spent 0.03",
    ]);
    expect(fake.watching()).toBe(0);
  });

  it("reports a stop it asked for as stopped and an interruption it did not as failed", async () => {
    const stopped = fakeHost();
    const handle = await threadRunner(stopped.host).start(request, recordingSignals().signals);
    await handle.stop();
    expect((await handle.finished).ended).toBe("stopped");

    const interrupted = fakeHost();
    const other = await threadRunner(interrupted.host).start(request, recordingSignals().signals);
    interrupted.signal({ kind: "turn-interrupted", text: "" });
    expect(await other.finished).toMatchObject({
      ended: "failed",
      reason: "the turn was interrupted",
    });
  });

  it("fails on an engine error or a session that vanished before the prompt", async () => {
    const erring = fakeHost();
    const handle = await threadRunner(erring.host).start(request, recordingSignals().signals);
    erring.signal({ kind: "error", message: "provider returned 529" });
    expect(await handle.finished).toMatchObject({
      ended: "failed",
      reason: "provider returned 529",
    });

    const vanished = await threadRunner(fakeHost("missing").host).start(
      request,
      recordingSignals().signals,
    );
    expect((await vanished.finished).reason).toContain("disappeared");
  });

  it("denies an ask through the host", async () => {
    const fake = fakeHost();
    const handle = await threadRunner(fake.host).start(request, recordingSignals().signals);
    await handle.deny("call-9");
    expect(fake.calls.at(-1)).toBe("deny call-9");
  });
});
