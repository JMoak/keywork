export interface Crash {
  unit: string;
  at: number;
  code: number | null;
  signal: string | null;
}

export interface CrashLoopPolicy {
  limit: number;
  windowMs: number;
}

export const crashLoopPolicy: CrashLoopPolicy = { limit: 3, windowMs: 5 * 60_000 };

export class CrashLedger {
  private crashes: Crash[] = [];

  constructor(private readonly policy: CrashLoopPolicy = crashLoopPolicy) {}

  record(crash: Crash): boolean {
    this.crashes = [...this.within(crash.at), crash];
    return this.crashes.length >= this.policy.limit;
  }

  recent(now: number): Crash[] {
    return this.within(now);
  }

  private within(now: number): Crash[] {
    return this.crashes.filter((crash) => now - crash.at < this.policy.windowMs);
  }
}

export function crashLoopReason(policy: CrashLoopPolicy = crashLoopPolicy): string {
  return `${spelled(policy.limit)} crashes in ${minutesOf(policy.windowMs)}`;
}

function spelled(count: number): string {
  return ["zero", "one", "two", "three", "four", "five"][count] ?? String(count);
}

function minutesOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "one minute" : `${spelled(minutes)} minutes`;
}
