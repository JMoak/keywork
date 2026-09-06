import { describe, expect, it } from "vitest";
import { Debounce, type DebounceTiming } from "./debounce.ts";

function fakeTiming() {
  let clock = 0;
  const armed: Array<{ dueAt: number; run: () => void; live: boolean }> = [];
  const timing: DebounceTiming = {
    now: () => clock,
    after: (delayMs, run) => {
      const entry = { dueAt: clock + delayMs, run, live: true };
      armed.push(entry);
      return () => {
        entry.live = false;
      };
    },
  };
  const advanceTo = (time: number): void => {
    clock = time;
    for (const entry of [...armed]) {
      if (entry.live && entry.dueAt <= clock) {
        entry.live = false;
        entry.run();
      }
    }
  };
  return { timing, advanceTo, armed: () => armed.filter((entry) => entry.live).length };
}

describe("Debounce", () => {
  it("fires once after the quiet period following a burst", () => {
    const { timing, advanceTo } = fakeTiming();
    let fired = 0;
    const debounce = new Debounce(100, () => (fired += 1), timing);
    debounce.touch();
    advanceTo(40);
    debounce.touch();
    advanceTo(90);
    debounce.touch();
    advanceTo(100);
    expect(fired).toBe(0);
    advanceTo(189);
    expect(fired).toBe(0);
    advanceTo(190);
    expect(fired).toBe(1);
    expect(debounce.pending()).toBe(false);
  });

  it("arms one timer per burst, never one per touch", () => {
    const { timing, advanceTo, armed } = fakeTiming();
    const debounce = new Debounce(50, () => {}, timing);
    for (let step = 0; step < 10; step += 1) {
      advanceTo(step);
      debounce.touch();
    }
    expect(armed()).toBe(1);
  });

  it("fires again for a second burst after the first settles", () => {
    const { timing, advanceTo } = fakeTiming();
    let fired = 0;
    const debounce = new Debounce(10, () => (fired += 1), timing);
    debounce.touch();
    advanceTo(10);
    expect(fired).toBe(1);
    advanceTo(500);
    debounce.touch();
    advanceTo(510);
    expect(fired).toBe(2);
  });

  it("dispose drops the armed timer so nothing fires afterwards", () => {
    const { timing, advanceTo } = fakeTiming();
    let fired = 0;
    const debounce = new Debounce(10, () => (fired += 1), timing);
    debounce.touch();
    debounce.dispose();
    advanceTo(1000);
    debounce.touch();
    advanceTo(2000);
    expect(fired).toBe(0);
    expect(debounce.pending()).toBe(false);
  });
});
