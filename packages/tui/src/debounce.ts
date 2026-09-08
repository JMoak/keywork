export interface DebounceTiming {
  now(): number;
  after(delayMs: number, run: () => void): () => void;
}

export const realTiming: DebounceTiming = {
  now: () => performance.now(),
  after: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export class Debounce {
  private lastTouch: number | undefined;
  private cancelArmed: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly quietMs: number,
    private readonly fire: () => void,
    private readonly timing: DebounceTiming = realTiming,
  ) {}

  touch(): void {
    if (this.disposed) return;
    this.lastTouch = this.timing.now();
    if (this.cancelArmed === undefined) this.arm(this.quietMs);
  }

  pending(): boolean {
    return this.cancelArmed !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelArmed?.();
    this.cancelArmed = undefined;
  }

  private arm(delayMs: number): void {
    this.cancelArmed = this.timing.after(delayMs, () => this.elapsed());
  }

  private elapsed(): void {
    this.cancelArmed = undefined;
    const quietFor = this.timing.now() - (this.lastTouch ?? 0);
    if (quietFor >= this.quietMs) this.fire();
    else this.arm(this.quietMs - quietFor);
  }
}
