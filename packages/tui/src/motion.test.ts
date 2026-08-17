import { describe, expect, it } from "vitest";
import { frameWrap } from "./capability.ts";
import {
  Animator,
  type AnimatorOptions,
  inkAt,
  type MotionSpec,
  type StepShape,
  stepProgress,
  type Tempo,
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

describe("tempos", () => {
  it("matches the tempo tables in the grammar", () => {
    expect(tempos.instant).toEqual({ durationMs: 0, steps: 1 });
    expect(tempos.quick.durationMs).toBe(120);
    expect(tempos.quick.steps).toBeGreaterThanOrEqual(2);
    expect(tempos.quick.steps).toBeLessThanOrEqual(3);
    expect(tempos.settle.durationMs).toBe(240);
    expect(tempos.settle.steps).toBeGreaterThanOrEqual(4);
    expect(tempos.settle.steps).toBeLessThanOrEqual(6);
    expect(tempos.ceremony.durationMs).toBeGreaterThanOrEqual(600);
    expect(tempos.ceremony.durationMs).toBeLessThanOrEqual(900);
  });
});

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

  it("gathers departures: softest step first, decisive last, ending exactly at 1", () => {
    const departure = deltas("departure", 5);
    expect(departure.every((step, i) => i === 0 || step > (departure[i - 1] ?? 0))).toBe(true);
    expect(stepProgress("departure", 5, 5)).toBe(1);
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

  it("lets different regions move concurrently", () => {
    const { clock, animator, play } = stage();
    const other: number[] = [];
    play();
    animator.play({
      region: "pane-2",
      tempo: "quick",
      shape: "departure",
      apply: (ink) => other.push(ink),
    });
    clock.advance(240);
    expect(other.at(-1)).toBe(1);
    expect(animator.moving).toBe(false);
  });

  it("permits at most one ceremony per moment, across regions", () => {
    const { clock, animator, frames, settledCount, play } = stage();
    play({ tempo: "ceremony" });
    clock.advance(90);
    const other: number[] = [];
    animator.play({
      region: "airlock",
      tempo: "ceremony",
      shape: "arrival",
      apply: (ink) => other.push(ink),
    });
    expect(frames.at(-1)).toBe(1);
    expect(settledCount()).toBe(1);
    clock.advance(720);
    expect(other.at(-1)).toBe(1);
  });

  it("leaves quick movers alone when a ceremony starts elsewhere", () => {
    const { clock, animator, frames, play } = stage();
    play({ tempo: "quick" });
    animator.play({
      region: "airlock",
      tempo: "ceremony",
      shape: "arrival",
      apply: () => {},
    });
    expect(frames.at(-1)).not.toBe(1);
    clock.advance(120);
    expect(frames.at(-1)).toBe(1);
  });

  it("jumps straight to the final frame under reduced motion", () => {
    const { clock, frames, settledCount, play } = stage({ reducedMotion: true });
    play({ tempo: "ceremony" });
    expect(frames).toEqual([1]);
    expect(settledCount()).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("treats instant as a single final frame", () => {
    const { clock, frames, play } = stage();
    play({ tempo: "instant" });
    expect(frames).toEqual([1]);
    expect(clock.pending).toBe(0);
  });

  it("ignores settling an idle region and animates a region again after it settles", () => {
    const { clock, animator, frames, play } = stage();
    animator.settleRegion("pane-1");
    expect(frames).toEqual([]);
    play({ tempo: "quick" });
    clock.advance(120);
    play({ tempo: "quick" });
    clock.advance(120);
    expect(frames.filter((ink) => ink === 1).length).toBe(2);
  });
});

describe("the synchronized frame hook", () => {
  it("fires once per step and carries the DEC 2026 wrap from detection", () => {
    const painted: string[] = [];
    const wrap = frameWrap({ synchronizedOutput: true });
    const clock = new TestClock();
    let ink = 0;
    const animator = new Animator({
      schedule: clock.schedule,
      onFrame: () => painted.push(wrap(`ink:${ink}`)),
    });
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
    expect(painted.every((frame) => frame.startsWith("\x1b[?2026h"))).toBe(true);
    expect(painted.at(-1)).toBe("\x1b[?2026hink:1\x1b[?2026l");
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

const tempoNames: Tempo[] = ["instant", "quick", "settle", "ceremony"];

describe("the grammar has exactly four tempos", () => {
  it("defines no animation outside them", () => {
    expect(Object.keys(tempos).sort()).toEqual([...tempoNames].sort());
  });
});
