import { describe, expect, it } from "vitest";
import {
  Animator,
  type AnimatorOptions,
  inkAt,
  type MotionSpec,
  type StepShape,
  stepProgress,
  tempos,
} from "./motion.ts";

class TestClock {
  now = 0;
  private tasks: { run: () => void; at: number; cancelled: boolean }[] = [];

  schedule = (run: () => void, delayMs: number): (() => void) => {
    const task = { run, at: this.now + delayMs, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  advance(ms: number): void {
    const horizon = this.now + ms;
    for (;;) {
      const due = this.tasks
        .filter((task) => !task.cancelled && task.at <= horizon)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.tasks = this.tasks.filter((task) => task !== due);
      this.now = due.at;
      due.run();
    }
    this.now = horizon;
  }

  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }
}

interface Stage {
  clock: TestClock;
  animator: Animator;
  frames: number[];
  settledCount: () => number;
  play: (overrides?: Partial<MotionSpec>) => void;
}

function stage(options: Omit<AnimatorOptions, "schedule"> = {}): Stage {
  const clock = new TestClock();
  const animator = new Animator({ ...options, schedule: clock.schedule });
  const frames: number[] = [];
  let settled = 0;
  const play = (overrides: Partial<MotionSpec> = {}): void => {
    animator.play({
      region: "pane-1",
      tempo: "settle",
      shape: "arrival",
      apply: (ink) => frames.push(ink),
      onSettled: () => {
        settled += 1;
      },
      ...overrides,
    });
  };
  return { clock, animator, frames, settledCount: () => settled, play };
}

describe("stepProgress", () => {
  const deltas = (shape: StepShape, steps: number): number[] =>
    Array.from({ length: steps }, (_, i) => stepProgress(shape, i + 1, steps)).map(
      (value, i, all) => value - (i === 0 ? 0 : (all[i - 1] ?? 0)),
    );

  it("snap-settles arrivals: largest step first, softest last, ending exactly at 1", () => {
    const arrival = deltas("arrival", 5);
    expect(arrival.every((step, i) => i === 0 || step < (arrival[i - 1] ?? 0))).toBe(true);
    expect(stepProgress("arrival", 5, 5)).toBe(1);
  });
});

describe("Animator", () => {
  it("emits the first step immediately and one step per interval after", () => {
    const { clock, frames, play } = stage();
    play({ tempo: "quick" });
    expect(frames.length).toBe(1);
    clock.advance(40);
    expect(frames.length).toBe(2);
    clock.advance(40);
    expect(frames.length).toBe(3);
    expect(frames.at(-1)).toBe(1);
  });

  it("completes to the exact final frame and reports settled", () => {
    const { clock, animator, frames, settledCount, play } = stage();
    play();
    clock.advance(tempos.settle.durationMs);
    expect(frames.at(-1)).toBe(1);
    expect(settledCount()).toBe(1);
    expect(animator.moving).toBe(false);
  });

  it("settles everything to exact final frames on keypress, with nothing after", () => {
    const { clock, animator, frames, settledCount, play } = stage();
    play();
    clock.advance(48);
    animator.settleAll();
    expect(frames.at(-1)).toBe(1);
    expect(settledCount()).toBe(1);
    const frameCount = frames.length;
    clock.advance(1000);
    expect(frames.length).toBe(frameCount);
    expect(clock.pending).toBe(0);
  });

  it("allows one mover per region: a second play settles the first before starting", () => {
    const { clock, frames, settledCount, play } = stage();
    play();
    clock.advance(48);
    const beforeSecond = frames.length;
    play({ shape: "departure" });
    expect(frames[beforeSecond]).toBe(1);
    expect(settledCount()).toBe(1);
    clock.advance(tempos.settle.durationMs);
    expect(frames.at(-1)).toBe(1);
    expect(settledCount()).toBe(2);
  });

  it("jumps straight to the final frame under reduced motion", () => {
    const { clock, frames, settledCount, play } = stage({ reducedMotion: true });
    play({ tempo: "ceremony" });
    expect(frames).toEqual([1]);
    expect(settledCount()).toBe(1);
    expect(clock.pending).toBe(0);
  });
});

describe("the frame hook", () => {
  it("fires once per step with the ink already applied", () => {
    const painted: number[] = [];
    const clock = new TestClock();
    let ink = 0;
    const animator = new Animator({ schedule: clock.schedule, onFrame: () => painted.push(ink) });
    animator.play({
      region: "pane-1",
      tempo: "quick",
      shape: "arrival",
      apply: (value) => {
        ink = value;
      },
    });
    clock.advance(120);
    expect(painted.length).toBe(tempos.quick.steps);
    expect(painted.at(-1)).toBe(1);
  });

  it("never re-enters a frame: a motion played while painting paints on the next tick", () => {
    const clock = new TestClock();
    let depth = 0;
    let deepest = 0;
    let frames = 0;
    const inks: number[] = [];
    const animator: Animator = new Animator({
      schedule: clock.schedule,
      onFrame: () => {
        depth += 1;
        deepest = Math.max(deepest, depth);
        frames += 1;
        if (frames === 1) {
          animator.play({
            region: "nested",
            tempo: "instant",
            shape: "arrival",
            apply: (ink) => inks.push(ink),
          });
        }
        depth -= 1;
      },
    });
    animator.play({ region: "outer", tempo: "instant", shape: "arrival", apply: () => {} });
    expect(deepest).toBe(1);
    expect(inks).toEqual([1]);
    expect(frames).toBe(1);
    clock.advance(0);
    expect(frames).toBe(2);
    expect(deepest).toBe(1);
  });

  it("a motion settled from inside its own frame schedules no further steps", () => {
    const clock = new TestClock();
    let frames = 0;
    const inks: number[] = [];
    const animator: Animator = new Animator({
      schedule: clock.schedule,
      onFrame: () => {
        frames += 1;
        if (frames === 1) animator.settleRegion("outer");
      },
    });
    animator.play({
      region: "outer",
      tempo: "quick",
      shape: "arrival",
      apply: (i) => inks.push(i),
    });
    expect(frames).toBe(1);
    expect(inks.at(-1)).toBe(1);
    expect(animator.moving).toBe(false);
    clock.advance(1000);
    expect(inks.length).toBe(2);
    expect(frames).toBe(2);
    expect(clock.pending).toBe(0);
  });

  it("flushes a deferred frame when everything is settled, leaving no timer behind", () => {
    const clock = new TestClock();
    let frames = 0;
    const animator: Animator = new Animator({
      schedule: clock.schedule,
      onFrame: () => {
        frames += 1;
        if (frames === 1) {
          animator.play({ region: "nested", tempo: "instant", shape: "arrival", apply: () => {} });
        }
      },
    });
    animator.play({ region: "outer", tempo: "quick", shape: "arrival", apply: () => {} });
    expect(frames).toBe(1);
    expect(clock.pending).toBe(2);
    animator.settleAll();
    expect(frames).toBe(3);
    expect(clock.pending).toBe(0);
  });
});

describe("inkAt", () => {
  const ramp = ["░", "▒", "▓", "█"];

  it("maps progress across the ramp with exact endpoints", () => {
    expect(inkAt(ramp, 0)).toBe("░");
    expect(inkAt(ramp, 1)).toBe("█");
    expect(inkAt(ramp, 1 / 3)).toBe("▒");
    expect(inkAt(ramp, 0.5)).toBe("▓");
  });

  it("clamps out-of-range progress and rejects an empty ramp", () => {
    expect(inkAt(ramp, -1)).toBe("░");
    expect(inkAt(ramp, 2)).toBe("█");
    expect(() => inkAt([], 0.5)).toThrow(/non-empty/);
  });
});
