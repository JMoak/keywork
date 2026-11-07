export interface DisplayFrame {
  readonly png: string;
  readonly at: string;
}

export interface DisplayPort {
  snapshot(): Promise<DisplayFrame | undefined>;
}

export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

export interface FramePacing {
  readonly signal: AbortSignal;
  readonly everyMs?: number;
  readonly pause?: Pause;
}

export const frameIntervalMs = 1_000;

export async function* displayFrames(
  display: DisplayPort,
  pacing: FramePacing,
): AsyncGenerator<DisplayFrame> {
  const pause = pacing.pause ?? abortablePause;
  while (!pacing.signal.aborted) {
    const frame = await display.snapshot();
    if (frame === undefined) return;
    yield frame;
    await pause(pacing.everyMs ?? frameIntervalMs, pacing.signal);
  }
}

export function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
