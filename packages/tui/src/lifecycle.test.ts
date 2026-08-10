import { describe, expect, it } from "vitest";
import { closeOnce, runClosers } from "./lifecycle.ts";

const never = (): Promise<void> => new Promise(() => {});

describe("runClosers", () => {
  it("resolves immediately with nothing registered", async () => {
    await expect(runClosers([], 50, () => {})).resolves.toBeUndefined();
  });

  it("awaits closers before resolving", async () => {
    const order: string[] = [];
    await runClosers(
      [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("slow");
        },
        async () => {
          order.push("fast");
        },
      ],
      1000,
      () => {},
    );
    expect(order.sort()).toEqual(["fast", "slow"]);
  });

  it("a hung closer trips the timeout and exit proceeds", async () => {
    const started = Date.now();
    await runClosers([never], 20, () => {});
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a throwing closer surfaces its error and still resolves", async () => {
    const reported: string[] = [];
    await runClosers(
      [
        async () => {
          throw new Error("sweep exploded");
        },
        () => {
          throw new Error("sync explosion");
        },
      ],
      1000,
      (error) => reported.push(error.message),
    );
    expect(reported.sort()).toEqual(["sweep exploded", "sync explosion"]);
  });

  it("wraps non-Error rejections before reporting", async () => {
    const reported: Error[] = [];
    await runClosers([() => Promise.reject("plain string")], 1000, (error) => {
      reported.push(error);
    });
    expect(reported[0]).toBeInstanceOf(Error);
    expect(reported[0]?.message).toBe("plain string");
  });
});

describe("closeOnce", () => {
  it("runs the close path exactly once no matter how many panes trigger it", async () => {
    let sweeps = 0;
    const shutdown = closeOnce(() => {
      void runClosers(
        [
          async () => {
            sweeps += 1;
          },
        ],
        1000,
        () => {},
      );
    });
    shutdown();
    shutdown();
    shutdown();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sweeps).toBe(1);
  });
});
