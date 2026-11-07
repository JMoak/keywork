export interface BackoffPolicy {
  readonly backoffFirstMs: number;
  readonly backoffMaxMs: number;
}

export function backoffMs(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.backoffFirstMs * 2 ** Math.max(0, attempt - 1), policy.backoffMaxMs);
}
