import { describe, expect, it } from "vitest";
import {
  type ExecutionStateSetter,
  type HeldProcess,
  inhibitorFor,
  KeepAwake,
  type KeepAwakeHost,
  keepAwake,
} from "./keep-awake.ts";

interface FakeChild {
  readonly command: string;
  readonly args: readonly string[];
  killed: number;
  fail(): void;
}

function fakeHost(platform: NodeJS.Platform, setter?: ExecutionStateSetter) {
  const children: FakeChild[] = [];
  const exitListeners: (() => void)[] = [];
  const host: KeepAwakeHost = {
    platform,
    pid: 4242,
    spawn: (command, args): HeldProcess => {
      const errorListeners: (() => void)[] = [];
      const child: FakeChild = {
        command,
        args,
        killed: 0,
        fail: () => {
          for (const listener of errorListeners) listener();
        },
      };
      children.push(child);
      return {
        kill: () => {
          child.killed += 1;
        },
        onError: (listener) => void errorListeners.push(listener),
      };
    },
    loadExecutionState: async () => setter,
    onExit: (listener) => void exitListeners.push(listener),
  };
  const exit = (): void => {
    for (const listener of exitListeners) listener();
  };
  return { host, children, exit };
}

describe("KeepAwake", () => {
  it("holds once while a turn runs and releases once when it ends", () => {
    const { host, children } = fakeHost("linux");
    const awake = keepAwake(host);
    awake.turnRunning(true);
    awake.turnRunning(true);
    expect(children).toHaveLength(1);
    expect(awake.holding).toBe(true);
    awake.turnRunning(false);
    awake.turnRunning(false);
    expect(children[0]?.killed).toBe(1);
    expect(awake.holding).toBe(false);
    awake.turnRunning(true);
    expect(children).toHaveLength(2);
  });

  it("releases on process exit and ignores every turn after it", () => {
    const { host, children, exit } = fakeHost("darwin");
    const awake = keepAwake(host);
    awake.turnRunning(true);
    exit();
    expect(children[0]?.killed).toBe(1);
    awake.dispose();
    awake.turnRunning(false);
    awake.turnRunning(true);
    expect(children).toHaveLength(1);
    expect(children[0]?.killed).toBe(1);
  });

  it("goes quiet for good once the helper binary turns out to be missing", () => {
    const { host, children } = fakeHost("linux");
    const awake = keepAwake(host);
    awake.turnRunning(true);
    children[0]?.fail();
    awake.turnRunning(false);
    awake.turnRunning(true);
    expect(children).toHaveLength(1);
    expect(awake.holding).toBe(false);
  });

  it("never throws when the spawner or the release does", () => {
    const awake = new KeepAwake({
      inhibit: () => () => {
        throw new Error("kill failed");
      },
    });
    awake.turnRunning(true);
    expect(() => awake.turnRunning(false)).not.toThrow();
    const broken = new KeepAwake({
      inhibit: () => {
        throw new Error("spawn failed");
      },
    });
    expect(() => broken.turnRunning(true)).not.toThrow();
    expect(broken.holding).toBe(false);
  });

  it("is a no-op on a platform it has no way to hold", () => {
    const { host, children } = fakeHost("freebsd");
    const awake = keepAwake(host);
    awake.turnRunning(true);
    expect(children).toHaveLength(0);
    expect(awake.holding).toBe(false);
  });
});

describe("inhibitorFor", () => {
  it("asks systemd for an idle inhibitor that dies with keywork on linux", () => {
    const { host, children } = fakeHost("linux");
    inhibitorFor(host)?.inhibit();
    expect(children[0]?.command).toBe("systemd-inhibit");
    expect(children[0]?.args).toEqual([
      "--what=idle",
      "--who=keywork",
      "--why=agent turn running",
      "tail",
      "--pid=4242",
      "-f",
      "/dev/null",
    ]);
  });

  it("runs caffeinate watching keywork's pid on macOS", () => {
    const { host, children } = fakeHost("darwin");
    inhibitorFor(host)?.inhibit();
    expect(children[0]?.command).toBe("caffeinate");
    expect(children[0]?.args).toEqual(["-i", "-w", "4242"]);
  });

  it("sets and clears the thread execution state on Windows without spawning", async () => {
    const flags: number[] = [];
    const { host, children } = fakeHost("win32", (value) => flags.push(value));
    const awake = keepAwake(host);
    awake.turnRunning(true);
    await Promise.resolve();
    await Promise.resolve();
    awake.turnRunning(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(children).toHaveLength(0);
    expect(flags).toEqual([0x80000001, 0x80000000]);
  });

  it("stays silent on Windows when the execution state cannot load", async () => {
    const { host } = fakeHost("win32");
    const failing: KeepAwakeHost = {
      ...host,
      loadExecutionState: () => Promise.reject(new Error("no ffi")),
    };
    const awake = keepAwake(failing);
    awake.turnRunning(true);
    awake.turnRunning(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(awake.holding).toBe(false);
  });
});
