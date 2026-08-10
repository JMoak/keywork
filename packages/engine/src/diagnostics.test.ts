import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { DiagnosticsLog, debugEnabled, debugLogFile, redactSecrets } from "./diagnostics.ts";
import { textMessage } from "./messages.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readLines(file: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(file, "utf8");
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("DiagnosticsLog", () => {
  it("writes one JSON object per line with ts, level, event, payload", async () => {
    const file = join(await tempDir(), "debug.jsonl");
    const log = await DiagnosticsLog.open(file);
    log.log("info", "run.started", { prompt: "hello" });
    log.log("error", "engine.error", { error: new Error("boom") });
    await log.flush();

    const lines = await readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", event: "run.started" });
    expect(Date.parse(lines[0]?.ts as string)).not.toBeNaN();
    expect(lines[1]).toMatchObject({
      level: "error",
      event: "engine.error",
      payload: { error: { name: "Error", message: "boom" } },
    });
  });

  it("taps every bus event and stops recording after untap", async () => {
    const file = join(await tempDir(), "debug.jsonl");
    const log = await DiagnosticsLog.open(file);
    const bus = new EventBus();
    const untap = log.tap(bus);

    bus.emit("turn.started", { userText: "hi" });
    bus.emit("turn.delta", { delta: { type: "text", text: "chunk" } });
    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } },
    });
    bus.emit("tool.finished", { callId: "c1", output: "ok", isError: false });
    bus.emit("turn.completed", {
      message: textMessage("assistant", "done"),
      usage: { inputTokens: 12, outputTokens: 34 },
    });
    bus.emit("turn.interrupted", { message: textMessage("assistant", "stopped") });
    bus.emit("engine.error", { error: new Error("bad") });
    untap();
    bus.emit("turn.started", { userText: "after untap" });
    await log.flush();

    const lines = await readLines(file);
    expect(lines.map((line) => line.event)).toEqual([
      "turn.started",
      "turn.delta",
      "tool.started",
      "tool.finished",
      "turn.completed",
      "turn.interrupted",
      "engine.error",
    ]);
    expect(lines.map((line) => line.level)).toEqual([
      "info",
      "debug",
      "info",
      "info",
      "info",
      "info",
      "error",
    ]);
  });

  it("never lands a key-shaped config value in the log", async () => {
    const secret = "sk-or-v1-abcdef0123456789abcdef0123456789";
    const file = join(await tempDir(), "debug.jsonl");
    const log = await DiagnosticsLog.open(file);
    log.log("info", "config.loaded", {
      model: "openrouter/auto",
      apiKeys: { openrouter: secret },
    });
    log.log("debug", "turn.delta", { delta: { type: "text", text: `my key is ${secret}` } });
    log.log("info", "provider.request", { headers: { Authorization: `Bearer ${secret}` } });
    await log.flush();

    const content = await readFile(file, "utf8");
    expect(content).not.toContain(secret);
    expect(content).not.toContain("sk-");
    expect(content).toContain("[redacted]");
    expect(content).toContain("openrouter/auto");
  });

  it("keeps token counts while redacting token-named strings", async () => {
    const file = join(await tempDir(), "debug.jsonl");
    const log = await DiagnosticsLog.open(file);
    log.log("info", "turn.completed", {
      usage: { inputTokens: 7, outputTokens: 11 },
      sessionToken: "tok_secret",
    });
    await log.flush();

    const [line] = await readLines(file);
    expect(line?.payload).toEqual({
      usage: { inputTokens: 7, outputTokens: 11 },
      sessionToken: "[redacted]",
    });
  });
});

describe("redactSecrets", () => {
  it("redacts secret-named fields, key-shaped strings, and arrays deterministically", () => {
    expect(
      redactSecrets({
        apiKey: "anything",
        nested: { authorization: ["a", "b"] },
        notes: ["safe", "leaked sk-abcdef123456789"],
        plain: "hello",
        count: 3,
        enabled: true,
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]" },
      notes: ["safe", "leaked [redacted]"],
      plain: "hello",
      count: 3,
      enabled: true,
    });
  });

  it("serializes errors to name and message with the message scrubbed", () => {
    expect(redactSecrets(new RangeError("denied for sk-abcdef123456789"))).toEqual({
      name: "RangeError",
      message: "denied for [redacted]",
    });
  });
});

describe("debugEnabled", () => {
  it("treats unset, empty, 0, and false as off; anything else as on", () => {
    expect(debugEnabled({})).toBe(false);
    expect(debugEnabled({ KEYWORK_DEBUG: "" })).toBe(false);
    expect(debugEnabled({ KEYWORK_DEBUG: "0" })).toBe(false);
    expect(debugEnabled({ KEYWORK_DEBUG: "False" })).toBe(false);
    expect(debugEnabled({ KEYWORK_DEBUG: "1" })).toBe(true);
    expect(debugEnabled({ KEYWORK_DEBUG: "true" })).toBe(true);
  });
});

describe("debugLogFile", () => {
  it("names a per-process file inside a debug sibling of the session dir", () => {
    expect(debugLogFile(join("sessions", "abc"), 1700000000000, 42)).toBe(
      ["sessions", "abc", "debug", "1700000000000-42.jsonl"].join(sep),
    );
  });
});
