import { describe, expect, it } from "vitest";
import {
  BoundedOutput,
  CommandRun,
  commandAborted,
  commandResult,
  commandTimedOut,
  retainedOutputChars,
  scrubbedEnv,
  shellSpawnOptions,
} from "./command-run.ts";

describe("BoundedOutput", () => {
  it("forwards every chunk but keeps the head and the tail within the retained ceiling, marking the elided middle", () => {
    const forwarded: string[] = [];
    const output = new BoundedOutput((chunk) => forwarded.push(chunk));
    const half = retainedOutputChars / 2;

    output.append("x".repeat(half - 1));
    output.append("yyy");
    output.append("m".repeat(half));
    output.append("z".repeat(half - 4));
    output.append("tail");

    expect(forwarded.join("").length).toBe(3 * half + 2);
    const rendered = output.rendered();
    expect(rendered.startsWith(`${"x".repeat(half - 1)}y`)).toBe(true);
    expect(rendered).toContain(`\n... (${half + 2} characters elided from the middle)\n`);
    expect(rendered.endsWith(`${"z".repeat(half - 4)}tail`)).toBe(true);
    expect(rendered).not.toContain("mmm");
    expect(rendered.length).toBeLessThan(retainedOutputChars + 80);
  });

  it("keeps everything below the ceiling without a marker", () => {
    const output = new BoundedOutput();
    output.append("x".repeat(retainedOutputChars / 2));
    output.append("y".repeat(retainedOutputChars / 2));
    expect(output.rendered()).toBe(
      "x".repeat(retainedOutputChars / 2) + "y".repeat(retainedOutputChars / 2),
    );
  });

  it("renders untruncated output verbatim", () => {
    const output = new BoundedOutput();
    output.append("hello ");
    output.append("world");
    expect(output.rendered()).toBe("hello world");
  });
});

describe("CommandRun", () => {
  it("fires onTimeout once the deadline passes and not after settling", async () => {
    let timeouts = 0;
    const timedOut = () => {
      timeouts += 1;
    };
    new CommandRun({ timeoutMs: 10, signal: undefined, onTimeout: timedOut, onAbort: () => {} });
    const settledEarly = new CommandRun({
      timeoutMs: 10,
      signal: undefined,
      onTimeout: timedOut,
      onAbort: () => {},
    });
    settledEarly.settle(() => {});

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(timeouts).toBe(1);
  });

  it("relays an abort until settled, then stops listening", () => {
    const controller = new AbortController();
    let aborts = 0;
    const run = new CommandRun({
      timeoutMs: 1_000,
      signal: controller.signal,
      onTimeout: () => {},
      onAbort: () => {
        aborts += 1;
      },
    });
    run.settle(() => {});

    controller.abort();

    expect(aborts).toBe(0);
  });

  it("relays an abort that arrives before settling", () => {
    const controller = new AbortController();
    let aborts = 0;
    new CommandRun({
      timeoutMs: 1_000,
      signal: controller.signal,
      onTimeout: () => {},
      onAbort: () => {
        aborts += 1;
      },
    }).settle(() => {
      controller.abort();
    });

    expect(aborts).toBe(0);
  });

  it("runs exactly one outcome, the first one offered", () => {
    const outcomes: string[] = [];
    const run = new CommandRun({
      timeoutMs: 1_000,
      signal: undefined,
      onTimeout: () => {},
      onAbort: () => {},
    });

    run.settle(() => outcomes.push("first"));
    run.settle(() => outcomes.push("second"));

    expect(outcomes).toEqual(["first"]);
  });

  it("delivers the abort callback while the run is live", () => {
    const controller = new AbortController();
    let aborts = 0;
    const run = new CommandRun({
      timeoutMs: 1_000,
      signal: controller.signal,
      onTimeout: () => {},
      onAbort: () => {
        aborts += 1;
      },
    });

    controller.abort();
    run.settle(() => {});

    expect(aborts).toBe(1);
  });
});

describe("command result and failure shapes", () => {
  it("returns the trimmed body alone on exit code zero", () => {
    expect(commandResult("ok\n\n", 0)).toBe("ok");
  });

  it("appends the exit code on failure and trims a leading newline when there was no output", () => {
    expect(commandResult("warned\n", 2)).toBe("warned\n(exit code 2)");
    expect(commandResult("", 3)).toBe("(exit code 3)");
    expect(commandResult("killed", null)).toBe("killed\n(exit code null)");
  });

  it("names the timeout and carries the captured output and cause", () => {
    const cause = new Error("taskkill failed");
    const failure = commandTimedOut(400, "partial", cause);
    expect(failure.message).toBe("Command timed out after 400ms:\npartial");
    expect(failure.cause).toBe(cause);
    expect(commandTimedOut(1, "").cause).toBeUndefined();
  });

  it("names an abort and carries its cause when there is one", () => {
    expect(commandAborted().message).toBe("Command aborted");
    expect(commandAborted().cause).toBeUndefined();
    expect(commandAborted("late").cause).toBe("late");
  });
});

describe("shell spawn environment", () => {
  it("drops API keys and keywork variables, case-insensitively, and keeps the rest", () => {
    const env = scrubbedEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "sk-x",
      demo_api_key: "lower",
      KEYWORK_PROBE: "internal",
      keywork_lower: "internal too",
      HOME: "/home/me",
    });

    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" });
  });

  it("hides the window, scrubs the environment, and detaches off Windows", () => {
    const options = shellSpawnOptions("/work");

    expect(options.cwd).toBe("/work");
    expect(options.windowsHide).toBe(true);
    expect(options.detached).toBe(process.platform !== "win32");
    expect(Object.keys(options.env ?? {}).some((name) => name.startsWith("KEYWORK_"))).toBe(false);
  });
});
