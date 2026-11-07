export type HealthState = "up" | "loading" | "saturated" | "down";

export interface HealthReading {
  state: HealthState;
  resident: boolean | null;
  detail: string;
  checkedAt: string;
}

export function healthReading(
  state: HealthState,
  detail: string,
  checkedAt: string,
  resident: boolean | null = null,
): HealthReading {
  return { state, resident, detail, checkedAt };
}
