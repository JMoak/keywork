export type Tempo = "instant" | "quick" | "settle" | "ceremony";
export type StepShape = "arrival" | "departure";

export interface TempoSpec {
  readonly durationMs: number;
  readonly steps: number;
}

export const tempos: Readonly<Record<Tempo, TempoSpec>> = {
  instant: { durationMs: 0, steps: 1 },
  quick: { durationMs: 120, steps: 3 },
  settle: { durationMs: 240, steps: 5 },
  ceremony: { durationMs: 720, steps: 8 },
};

export function stepProgress(shape: StepShape, step: number, steps: number): number {
  const linear = step / steps;
  return shape === "arrival" ? 1 - (1 - linear) ** 2 : linear ** 2;
}

export function inkAt(ramp: readonly string[], progress: number): string {
  const last = ramp.length - 1;
  const index = Math.min(Math.max(Math.round(progress * last), 0), last);
  const glyph = ramp[index];
  if (glyph === undefined) throw new Error("inkAt needs a non-empty ramp");
  return glyph;
}

export interface MotionSpec {
  readonly region: string;
  readonly tempo: Tempo;
  readonly shape: StepShape;
  readonly apply: (ink: number) => void;
  readonly onSettled?: () => void;
}

export type CancelTimer = () => void;
export type Scheduler = (run: () => void, delayMs: number) => CancelTimer;

export interface AnimatorOptions {
  readonly reducedMotion?: boolean;
  readonly schedule?: Scheduler;
  readonly onFrame?: () => void;
}

export class Animator {
  private readonly reducedMotion: boolean;
  private readonly schedule: Scheduler;
  private readonly onFrame: (() => void) | undefined;
  private readonly active = new Map<string, ActiveMotion>();

  constructor(options: AnimatorOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.schedule = options.schedule ?? scheduleWithTimeout;
    this.onFrame = options.onFrame;
  }

  play(spec: MotionSpec): void {
    this.settleRegion(spec.region);
    if (spec.tempo === "ceremony") this.settleCeremonies();
    if (this.reducedMotion || tempos[spec.tempo].steps <= 1) {
      this.emit(spec, 1);
      spec.onSettled?.();
      return;
    }
    const motion: ActiveMotion = { spec, step: 0, cancel: undefined };
    this.active.set(spec.region, motion);
    this.advance(motion);
  }

  settleRegion(region: string): void {
    const motion = this.active.get(region);
    if (motion === undefined) return;
    motion.cancel?.();
    this.active.delete(region);
    this.emit(motion.spec, 1);
    motion.spec.onSettled?.();
  }

  settleAll(): void {
    for (const region of [...this.active.keys()]) this.settleRegion(region);
  }

  get moving(): boolean {
    return this.active.size > 0;
  }

  private settleCeremonies(): void {
    for (const [region, motion] of [...this.active]) {
      if (motion.spec.tempo === "ceremony") this.settleRegion(region);
    }
  }

  private advance(motion: ActiveMotion): void {
    motion.step += 1;
    const { steps, durationMs } = tempos[motion.spec.tempo];
    this.emit(motion.spec, stepProgress(motion.spec.shape, motion.step, steps));
    if (motion.step >= steps) {
      this.active.delete(motion.spec.region);
      motion.spec.onSettled?.();
      return;
    }
    motion.cancel = this.schedule(() => this.advance(motion), durationMs / steps);
  }

  private emit(spec: MotionSpec, progress: number): void {
    spec.apply(progress);
    this.onFrame?.();
  }
}

interface ActiveMotion {
  readonly spec: MotionSpec;
  step: number;
  cancel: CancelTimer | undefined;
}

const scheduleWithTimeout: Scheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};
