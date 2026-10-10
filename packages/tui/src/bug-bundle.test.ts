import { EventBus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  type BugBundleFacts,
  bugBundleText,
  bugCommand,
  EventRecorder,
  recordedEventLimit,
  sessionShape,
  stripSecretKeys,
  writeBugBundle,
} from "./bug-bundle.ts";

const facts: BugBundleFacts = {
  version: "0.9.1",
  os: { platform: "win32", release: "10.0.26200", arch: "x64" },
  bun: "1.3.9",
  terminal: { TERM: "xterm-256color", windowsTerminal: true, glyphTier: 2 },
  config: {
    model: "anthropic/claude-sonnet-4-5",
    mcpServers: {
      github: { env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD" } },
    },
    apiKeys: { openai: "sk-live-1234567890" },
    nested: [{ secretStore: "vault", keep: "this" }],
  },
  events: [{ at: "2026-10-07T10:00:00.000Z", type: "tool.started", detail: "bash" }],
};

describe("bugBundleText", () => {
  it("strips secret-looking keys, redacts token shapes and keeps the rest", () => {
    const text = bugBundleText(facts, [{ name: "home", value: "/Users/jordan" }]);
    const bundle = JSON.parse(text) as Record<string, unknown>;
    expect(bundle.keywork).toBe("0.9.1");
    expect(bundle.bun).toBe("1.3.9");
    expect(bundle.config).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      mcpServers: { github: { env: "‹stripped›" } },
      apiKeys: "‹stripped›",
      nested: [{ secretStore: "‹stripped›", keep: "this" }],
    });
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("sk-live");
  });

  it("says when the host gave no config and no conversation is focused", () => {
    const bundle = JSON.parse(
      bugBundleText({ ...facts, config: undefined, version: undefined }, []),
    ) as Record<string, unknown>;
    expect(bundle.config).toBe("not provided by the host");
    expect(bundle.session).toBe("no conversation focused");
    expect(bundle.keywork).toBe("unknown");
  });

  it("redacts exact secret values anywhere in the bundle", () => {
    const text = bugBundleText(
      { ...facts, events: [{ at: "t", type: "engine.error", detail: "token hunter2secret died" }] },
      [{ name: "pw", value: "hunter2secret" }],
    );
    expect(text).toContain("‹redacted:pw›");
    expect(text).not.toContain("hunter2secret");
  });
});

describe("stripSecretKeys", () => {
  it("walks arrays and objects and leaves scalars alone", () => {
    expect(stripSecretKeys(["a", { password: "x", ok: 1 }])).toEqual([
      "a",
      { password: "‹stripped›", ok: 1 },
    ]);
    expect(stripSecretKeys(7)).toBe(7);
    expect(stripSecretKeys(null)).toBeNull();
  });
});

describe("sessionShape", () => {
  it("keeps message shapes and tool names but never message contents", () => {
    const shape = sessionShape(
      [
        { role: "user", parts: [{ type: "text", text: "secret plans" }] },
        {
          role: "assistant",
          parts: [
            { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool-result", callId: "c1", output: "x".repeat(40), isError: false }],
        },
      ],
      [
        { kind: "info", text: "fine" },
        { kind: "error", text: "boom with ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD" },
      ],
      [],
      { id: "s1", model: "mock/one" },
    );
    expect(shape).toEqual({
      id: "s1",
      model: "mock/one",
      messages: [
        { role: "user", parts: [{ type: "text", chars: 12 }] },
        {
          role: "assistant",
          parts: [
            { type: "tool-call", name: "bash" },
            { type: "image", mediaType: "image/png", chars: 4 },
          ],
        },
        { role: "tool", parts: [{ type: "tool-result", chars: 40, isError: false }] },
      ],
      recentErrors: ["boom with ‹redacted:github›"],
    });
    expect(JSON.stringify(shape)).not.toContain("secret plans");
  });
});

describe("EventRecorder", () => {
  it("summarises bus events without contents and caps the ring", () => {
    const clock = { now: 1_700_000_000_000 };
    const recorder = new EventRecorder(3, () => clock.now);
    const bus = new EventBus();
    const stop = recorder.follow(bus);
    bus.emit("turn.started", { userText: "go now" });
    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "echo", arguments: { text: "hi" } },
    });
    bus.emit("tool.finished", { callId: "c1", output: "hi back", isError: false });
    bus.emit("turn.completed", {
      message: { role: "assistant", parts: [{ type: "text", text: "done" }] },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(recorder.recent()).toEqual([
      { at: "2023-11-14T22:13:20.000Z", type: "tool.started", detail: "echo" },
      { at: "2023-11-14T22:13:20.000Z", type: "tool.finished", detail: "ok · 7 chars" },
      { at: "2023-11-14T22:13:20.000Z", type: "turn.completed", detail: "12▸3" },
    ]);
    expect(JSON.stringify(recorder.recent())).not.toContain("hi back");
    stop();
    bus.emit("shell.reset", {});
    expect(recorder.recent().length).toBe(3);
  });

  it("skips replayed events and holds the default limit", () => {
    const recorder = new EventRecorder();
    const bus = new EventBus();
    recorder.follow(bus);
    bus.emit("session.mode", { mode: "plan", replay: true });
    for (let turn = 0; turn < recordedEventLimit + 5; turn += 1) {
      bus.emit("session.mode", { mode: `m${turn}` });
    }
    expect(recorder.recent().length).toBe(recordedEventLimit);
    expect(recorder.recent()[0]?.detail).toBe("m5");
  });
});

describe("bugCommand", () => {
  it("writes the bundle under the reports dir and prints the path into the session", () => {
    const written: Array<[string, string]> = [];
    const posted: string[] = [];
    const command = bugCommand({
      facts: () => facts,
      notice: () => {
        throw new Error("the session should take the line");
      },
      post: (text) => {
        posted.push(text);
        return true;
      },
      dir: "/tmp/reports",
      now: () => new Date("2026-10-07T10:11:12.345Z"),
      write: (path, text) => written.push([path, text]),
    });
    expect(command.name).toBe("bug");
    command.run();
    expect(written[0]?.[0].replace(/\\/g, "/")).toBe(
      "/tmp/reports/bug-2026-10-07T10-11-12-345Z.json",
    );
    expect(posted).toEqual([
      `bug report written · ${written[0]?.[0]} · nothing leaves this machine`,
    ]);
  });

  it("falls back to the status notice and reports write failures", () => {
    const notices: string[] = [];
    bugCommand({
      facts: () => facts,
      notice: (text) => notices.push(text),
      dir: "/tmp/reports",
      write: () => {},
    }).run();
    expect(notices[0]).toMatch(/^bug report written · /);
    bugCommand({
      facts: () => facts,
      notice: (text) => notices.push(text),
      write: () => {
        throw new Error("disk full");
      },
    }).run();
    expect(notices[1]).toBe("bug report failed · disk full");
    expect(() =>
      writeBugBundle({
        facts: () => facts,
        notice: () => {},
        dir: "/tmp/reports",
        write: () => {},
      }),
    ).not.toThrow();
  });
});
