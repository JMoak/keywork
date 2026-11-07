export type Cancel = () => void;

export interface Clock {
  now(): number;
  at(when: number, fire: () => void): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  at: atSystemTime,
};

export const minuteMs = 60_000;
export const hourMs = 60 * minuteMs;
export const dayMs = 24 * hourMs;

export function isoOf(instant: number): string {
  return new Date(instant).toISOString();
}

const longestTimerDelayMs = 2 ** 31 - 1;

function atSystemTime(when: number, fire: () => void): Cancel {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const delay = Math.max(0, when - Date.now());
    handle =
      delay > longestTimerDelayMs ? setTimeout(arm, longestTimerDelayMs) : setTimeout(fire, delay);
  };
  arm();
  return () => clearTimeout(handle);
}
