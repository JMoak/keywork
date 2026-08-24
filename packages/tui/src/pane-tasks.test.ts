import { describe, expect, it } from "vitest";
import { failureMessage, PaneTasks } from "./pane-tasks.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
} {
  let resolve: () => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<void>((fulfil, fail) => {
    resolve = fulfil;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

  it("survives a task rejecting with undefined: one notify, a failure, settled resolves", async () => {
    let notified = 0;
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const tasks = new PaneTasks(() => {
        notified += 1;
      });
      tasks.track(() => Promise.reject(undefined));
      await expect(tasks.settled()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(tasks.failure()).toBe("undefined");
      expect(notified).toBe(1);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps a failure that lands while a slower unrelated task is still running", async () => {
    const tasks = new PaneTasks(() => {});
    const failing = deferred();
    const succeeding = deferred();
    tasks.track(() => failing.promise);
    tasks.track(() => succeeding.promise);
    failing.reject(new Error("load failed"));
    await new Promise((resolve) => setImmediate(resolve));
    succeeding.resolve();
    await tasks.settled();
    expect(tasks.failure()).toBe("load failed");
  });

  it("clears a failure when a task started after it succeeds", async () => {
    const tasks = new PaneTasks(() => {});
    tasks.track(() => Promise.reject(new Error("stale")));
    await tasks.settled();
    const refresh = deferred();
    tasks.track(() => refresh.promise);
    refresh.resolve();
    await tasks.settled();
    expect(tasks.failure()).toBeUndefined();
  });

  it("reports the latest of several live failures", async () => {
    const tasks = new PaneTasks(() => {});
    tasks.track(() => Promise.reject(new Error("first")));
    await tasks.settled();
    tasks.track(() => Promise.reject(new Error("second")));
    await tasks.settled();
    expect(tasks.failure()).toBe("second");
  });

  it("starts no new work and stops notifying once disposed", async () => {
    let notified = 0;
    let ran = 0;
    const tasks = new PaneTasks(() => {
      notified += 1;
    });
    const held = deferred();
    tasks.track(() => held.promise);
    tasks.dispose();
    tasks.track(() => {
      ran += 1;
      return Promise.resolve();
    });
    held.resolve();
    await tasks.settled();
    expect(ran).toBe(0);
    expect(notified).toBe(0);
    expect(tasks.live()).toBe(false);
  });

  it("settled drains in-flight work even after dispose", async () => {
    const tasks = new PaneTasks(() => {});
    const held = deferred();
    let finished = false;
    tasks.track(async () => {
      await held.promise;
      finished = true;
    });
    tasks.dispose();
    held.resolve();
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

describe("failureMessage", () => {
  it("reads an Error's message and stringifies anything else", () => {
    expect(failureMessage(new Error("boom"))).toBe("boom");
    expect(failureMessage("plain")).toBe("plain");
    expect(failureMessage(undefined)).toBe("undefined");
    expect(failureMessage(null)).toBe("null");
  });
});
