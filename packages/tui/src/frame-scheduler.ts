export type FrameScheduler = (run: () => void) => () => void;

const frameMs = 16;

export const nextFrame: FrameScheduler = (run) => {
  const timer = setTimeout(run, frameMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class FrameCoalescer {
  private cancelPending: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly schedule: FrameScheduler,
    private readonly run: () => void,
  ) {}

  request(): void {
    if (this.disposed || this.cancelPending !== undefined) return;
    this.cancelPending = this.schedule(() => {
      this.cancelPending = undefined;
      this.run();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending?.();
    this.cancelPending = undefined;
  }
}
