import type { ProviderWait } from "@keywork/engine";
import type {
  EventLog,
  ModelWait,
  ModelWaitChange,
  ModelWaitReason,
  ModelWaitsPort,
} from "@keywork/server";

export interface WaitingSession {
  creature: string | null;
  server: string | null;
}

export interface FollowedModelWaits extends ModelWaitsPort {
  close(): void;
}

export const shortestReportedWaitMs = 2_000;

export function followModelWaits(
  log: Pick<EventLog, "subscribe">,
  sessionOf: (id: string) => WaitingSession,
  reportAfterMs = shortestReportedWaitMs,
): FollowedModelWaits {
  const waits = new Map<string, Waiting>();
  const listeners = new Set<(change: ModelWaitChange) => void>();
  const announce = (change: ModelWaitChange): void => {
    for (const listener of [...listeners]) listener(change);
  };
  const end = (session: string): void => {
    const waiting = waits.get(session);
    if (waiting === undefined) return;
    waits.delete(session);
    clearTimeout(waiting.timer);
    if (waiting.reported) announce({ change: "over", wait: waiting.wait });
  };
  const begin = (session: string, reason: ModelWaitReason, since: string): void => {
    if (waits.has(session)) return;
    const wait: ModelWait = { session, ...sessionOf(session), reason, since };
    const timer = setTimeout(() => {
      const waiting = waits.get(session);
      if (waiting?.wait !== wait) return;
      waiting.reported = true;
      announce({ change: "waiting", wait });
    }, reportAfterMs);
    timer.unref?.();
    waits.set(session, { wait, timer, reported: false });
  };
  const unfollow = log.subscribe(({ sessionId, type, payload, ts }) => {
    if (replayed(payload)) return;
    if (type === "turn.waiting") {
      const reason = reasonOf((payload as ProviderWait).reason);
      if (reason !== undefined) begin(sessionId, reason, ts);
      return;
    }
    if (endsAWait.has(type)) end(sessionId);
  });
  return {
    list: () =>
      [...waits.values()]
        .filter(({ reported }) => reported)
        .map(({ wait }) => wait)
        .sort((left, right) => left.since.localeCompare(right.since)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      unfollow();
      for (const { timer } of waits.values()) clearTimeout(timer);
      waits.clear();
    },
  };
}

interface Waiting {
  wait: ModelWait;
  timer: ReturnType<typeof setTimeout>;
  reported: boolean;
}

const endsAWait: ReadonlySet<string> = new Set([
  "turn.delta",
  "turn.completed",
  "turn.interrupted",
  "engine.error",
  "session.settled",
]);

function reasonOf(reason: ProviderWait["reason"]): ModelWaitReason | undefined {
  if (reason === "rate-limited") return "limited";
  if (reason === "overloaded") return "busy";
  return undefined;
}

export function localServerOf(endpoint: string | undefined): string | null {
  if (endpoint === undefined) return null;
  try {
    const url = new URL(endpoint);
    return loopbackHosts.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

const loopbackHosts: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function replayed(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { replay?: unknown }).replay === true
  );
}
