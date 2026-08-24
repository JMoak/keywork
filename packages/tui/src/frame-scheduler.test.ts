import { describe, expect, it } from "vitest";
import { FrameCoalescer, type FrameScheduler, nextFrame } from "./frame-scheduler.ts";

function manualFrames(): { schedule: FrameScheduler; pending: Array<() => void> } {
  const pending: Array<() => void> = [];
  return {
    pending,
    schedule: (run) => {
      pending.push(run);
      return () => {
        const at = pending.indexOf(run);
        if (at !== -1) pending.splice(at, 1);
      };
    },
  };
}

describe("FrameCoalescer", () => {
  it("folds a burst of requests into one run per frame", () => {
    const frames = manualFrames();
    let runs = 0;
    const coalescer = new FrameCoalescer(frames.schedule, () => {
      runs += 1;
    });
    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(frames.pending).toHaveLength(1);
    for (const run of frames.pending.splice(0)) run();
    expect(runs).toBe(1);
    coalescer.request();
    expect(frames.pending).toHaveLength(1);
  });

  it("cancels the pending frame on dispose and refuses later requests", () => {
    const frames = manualFrames();
    let runs = 0;
    const coalescer = new FrameCoalescer(frames.schedule, () => {
      runs += 1;
    });
    coalescer.request();
    coalescer.dispose();
    expect(frames.pending).toHaveLength(0);
    coalescer.request();
    expect(frames.pending).toHaveLength(0);
    expect(runs).toBe(0);
  });

  it("runs on the real frame timer and can be cancelled before it fires", async () => {
    let ran = 0;
    const cancel = nextFrame(() => {
      ran += 1;
    });
    cancel();
    nextFrame(() => {
      ran += 10;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ran).toBe(10);
  });
});
