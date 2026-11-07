export type RunTrigger = "cron" | "interval" | "at" | "file-watch" | "webhook" | "event" | "manual";

export type RunStatus = "running" | "parked" | "ended" | "skipped" | "dropped";

export type RunProcess = "completed" | "failed" | "cancelled" | "timed-out" | "blocked";

export type RunDelivery = "delivered" | "unknown" | "failed" | "none";

export type NotificationTier = "interrupt" | "digest" | "log";

export type RunKind = "agent";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunNotice {
  tier: NotificationTier;
  at: string | null;
}

export interface RunRow {
  runId: string;
  creature: string;
  routineId: string;
  attempt: number;
  trigger: RunTrigger;
  catchUp: boolean;
  firedAt: string;
  scheduledFor: string;
  status: RunStatus;
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  process: RunProcess | null;
  delivery: RunDelivery | null;
  verified: boolean | null;
  reason: string | null;
  usage: RunUsage | null;
  cost: { usd: number } | null;
  output: string | null;
  notify: RunNotice | null;
}

export interface RunEnding {
  process: RunProcess;
  delivery: RunDelivery;
  verified: boolean | null;
  reason: string | null;
  usage: RunUsage | null;
  costUsd: number | null;
  output: string | null;
  notify: { tier: NotificationTier; at: number | null };
}

export function isActive(run: Pick<RunRow, "status">): boolean {
  return run.status === "running" || run.status === "parked";
}

export function needsKeeper(run: Pick<RunRow, "process" | "delivery">): boolean {
  return (
    run.process === "failed" ||
    run.process === "timed-out" ||
    run.process === "blocked" ||
    run.delivery === "unknown" ||
    run.delivery === "failed"
  );
}
