import { describe, expect, it } from "vitest";
import { PaneTasks } from "./pane-tasks.ts";

describe("PaneTasks", () => {
  it("notifies after each tracked task and records failures until the next success", async () => {
    let notified = 0;
    const tasks = new PaneTasks(() => {
      notified += 1;
    });
    tasks.track(() => Promise.resolve());
    await tasks.settled();
    expect(notified).toBe(1);
    expect(tasks.failure()).toBeUndefined();

    tasks.track(() => Promise.reject(new Error("boom")));
    await tasks.settled();
    expect(tasks.failure()).toBe("boom");

    tasks.track(() => Promise.resolve());
    await tasks.settled();
    expect(tasks.failure()).toBeUndefined();
  });

  it("starts no new work and stops notifying once disposed", async () => {
    let notified = 0;
    let ran = 0;
    const tasks = new PaneTasks(() => {
      notified += 1;
    });
    let release: () => void = () => {};
    tasks.track(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    tasks.dispose();
    tasks.track(() => {
      ran += 1;
      return Promise.resolve();
    });
    release();
    await tasks.settled();
    expect(ran).toBe(0);
    expect(notified).toBe(0);
    expect(tasks.live()).toBe(false);
  });

  it("settled drains in-flight work even after dispose", async () => {
    const tasks = new PaneTasks(() => {});
    let finished = false;
    tasks.track(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    });
    tasks.dispose();
    await tasks.settled();
    expect(finished).toBe(true);
  });

  it("emit forwards only while live", () => {
    let notified = 0;
    const tasks = new PaneTasks(() => {
      notified += 1;
    });
    tasks.emit();
    tasks.dispose();
    tasks.emit();
    expect(notified).toBe(1);
  });
});
