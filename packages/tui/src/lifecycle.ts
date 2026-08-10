export type Closer = () => Promise<void>;

export const defaultCloseTimeoutMs = 5000;

export function closeOnce(close: () => void): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    close();
  };
}

export async function runClosers(
  closers: readonly Closer[],
  timeoutMs: number,
  report: (error: Error) => void,
): Promise<void> {
  if (closers.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const settled = Promise.allSettled(closers.map((closer) => Promise.resolve().then(closer))).then(
    (outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") report(toError(outcome.reason));
      }
    },
  );
  try {
    await Promise.race([settled, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
