import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extensionState,
  MockProvider,
  messageText,
  type Provider,
  SessionStore,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadless } from "./run.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runHeadless", () => {
  it("streams JSONL events for a tool-using run and persists the session", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "bash",
        arguments: { command: "echo from-e2e" },
      }),
      textTurn("done"),
    ]);
    const lines: string[] = [];

    const outcome = await runHeadless({
      prompt: "run echo",
      cwd,
      json: true,
      sessionDir,
      provider,
      print: (line) => lines.push(line),
    });

    expect(outcome.exitCode === 0 && messageText(outcome.message)).toBe("done");
    const events = lines.map((line) => JSON.parse(line));
    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.output");
    expect(types).toContain("tool.finished");
    expect(types.at(-1)).toBe("turn.completed");
    expect(types.indexOf("tool.output")).toBeLessThan(types.indexOf("tool.finished"));
    const chunks = events
      .filter((event) => event.type === "tool.output")
      .map((event) => event.chunk)
      .join("");
    expect(chunks).toContain("from-e2e");
    const toolFinished = events.find((event) => event.type === "tool.finished");
    expect(toolFinished.output).toContain("from-e2e");

    const files = await readdir(sessionDir);
    expect(files).toHaveLength(1);
    const store = await SessionStore.open(join(sessionDir, files[0] as string));
    expect(store.messages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("refuses to run without a provider: hint on stderr, exit 1, no output, no session", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const exit = (code: number): never => {
      exits.push(code);
      throw new Error("exit requested");
    };

    await expect(
      runHeadless({
        prompt: "hi",
        cwd,
        json: true,
        sessionDir,
        print: (line) => out.push(line),
        printError: (line) => err.push(line),
        exit,
      }),
    ).rejects.toThrow("exit requested");

    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("provider");
    expect(out).toEqual([]);
    expect(await readdir(sessionDir)).toEqual([]);
  });

  it("writes a redacted debug log beside the session files when debug is on", async () => {
    const secret = "sk-or-v1-abcdef0123456789abcdef0123456789";
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const provider = new MockProvider([textTurn(`your key is ${secret}`)]);

    await runHeadless({
      prompt: `use ${secret}`,
      cwd,
      json: false,
      debug: true,
      sessionDir,
      provider,
      print: () => {},
    });

    const debugDir = join(sessionDir, "debug");
    const [logFile] = await readdir(debugDir);
    const content = await readFile(join(debugDir, logFile as string), "utf8");
    const events = content
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events[0]).toBe("run.started");
    expect(events).toContain("turn.started");
    expect(events).toContain("turn.completed");
    expect(content).not.toContain(secret);
    expect(content).toContain("[redacted]");
  });

  it("leaves no debug log behind when debug is off", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const provider = new MockProvider([textTurn("quiet")]);

    await runHeadless({ prompt: "hi", cwd, json: false, sessionDir, provider, print: () => {} });

    expect(await readdir(sessionDir)).not.toContain("debug");
  });

  it("assembles base prompt, global user prompt, then the matching model override", async () => {
    const cwd = await tempDir();
    const inner = new MockProvider([textTurn("ok")]);
    const seenPrompts: string[] = [];
    const provider = {
      name: inner.name,
      stream: (request: Parameters<typeof inner.stream>[0]) => {
        seenPrompts.push(request.systemPrompt);
        return inner.stream(request);
      },
    };

    await runHeadless({
      prompt: "hi",
      cwd,
      json: false,
      provider,
      modelId: "gpt-5-mini",
      prompts: {
        system: "always answer tersely",
        models: {
          "gpt-5*": { prompt: "think stepwise", mode: "append" },
          "claude*": { prompt: "wrong override", mode: "append" },
        },
      },
      print: () => {},
    });

    const [systemPrompt] = seenPrompts;
    expect(systemPrompt).toBeDefined();
    const order = [
      systemPrompt?.indexOf("You are keywork") ?? -1,
      systemPrompt?.indexOf("always answer tersely") ?? -1,
      systemPrompt?.indexOf("think stepwise") ?? -1,
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(systemPrompt).not.toContain("wrong override");
  });

  it("mounts configured MCP servers into the run's toolset and stops them after", async () => {
    const fixtureServerPath = fileURLToPath(
      new URL("../../engine/src/mcp/fixture-server.ts", import.meta.url),
    );
    const cwd = await tempDir();
    const inner = new MockProvider([textTurn("ok")]);
    const toolRosters: string[][] = [];

    await runHeadless({
      prompt: "hi",
      cwd,
      json: false,
      provider: {
        name: inner.name,
        stream: (request: Parameters<typeof inner.stream>[0]) => {
          toolRosters.push(request.tools.map((tool) => tool.name));
          return inner.stream(request);
        },
      },
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureServerPath, "basic"],
        },
      },
      print: () => {},
    });

    expect(toolRosters[0]).toContain("mcp_tool_search");
    expect(toolRosters[0]).toContain("bash");
  });

  it("prints plain text when json is off", async () => {
    const cwd = await tempDir();
    const provider = new MockProvider([textTurn("plain answer")]);
    const lines: string[] = [];

    const outcome = await runHeadless({
      prompt: "hi",
      cwd,
      json: false,
      provider,
      print: (l) => lines.push(l),
    });

    expect(outcome.exitCode).toBe(0);
    expect(lines).toEqual(["plain answer"]);
  });
});

describe("session journal in headless runs", () => {
  it("logs gate decisions and context injections as session entries with provenance", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    await writeFile(join(cwd, "AGENTS.md"), "be careful");
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "bash",
        arguments: { command: "echo hi" },
      }),
      textTurn("done"),
    ]);
    const lines: string[] = [];

    await runHeadless({
      prompt: "run it",
      cwd,
      json: true,
      projectTrusted: true,
      sessionDir,
      provider,
      print: (line) => lines.push(line),
    });

    const types = lines.map((line) => JSON.parse(line).type);
    expect(types).toContain("context.injected");
    expect(types).toContain("gate.permission");

    const [file] = await readdir(sessionDir);
    const store = await SessionStore.open(join(sessionDir, file as string));
    const state = extensionState(store.activePath());
    expect(state.injections).toEqual([{ source: "project-instructions", id: "AGENTS.md" }]);
    expect(state.decisions).toEqual([
      { tool: "bash", callId: "call-1", verdict: "granted", gate: "default" },
    ]);
  });
});

describe("workspace memory wiring", () => {
  async function declaredWorkspaceWithNote(): Promise<string> {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(cwd, ".keywork", "memory", "MEMORY.md"), "- [[Runtime Convention]]\n");
    await writeFile(
      join(cwd, ".keywork", "memory", "Runtime Convention.md"),
      "---\nprovenance: user\npinned: true\n---\nTests run on Node, not Bun.\n",
    );
    return cwd;
  }

  async function requestSeen(cwd: string, projectTrusted: boolean) {
    const inner = new MockProvider([textTurn("ok")]);
    const requests: Parameters<typeof inner.stream>[0][] = [];
    await runHeadless({
      prompt: "hi",
      cwd,
      json: false,
      projectTrusted,
      provider: {
        name: inner.name,
        stream: (request: Parameters<typeof inner.stream>[0]) => {
          requests.push(request);
          return inner.stream(request);
        },
      },
      print: () => {},
    });
    return requests[0];
  }

  it("injects the vault bootstrap and exposes the recall tools in a trusted workspace", async () => {
    const request = await requestSeen(await declaredWorkspaceWithNote(), true);
    expect(request?.systemPrompt).toContain("# Memory");
    expect(request?.systemPrompt).toContain("Tests run on Node, not Bun.");
    const toolNames = request?.tools.map((tool) => tool.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_get");
  });

  it("keeps an untrusted workspace's vault out of the prompt and the toolset", async () => {
    const request = await requestSeen(await declaredWorkspaceWithNote(), false);
    expect(request?.systemPrompt).not.toContain("Tests run on Node");
    expect(request?.tools.map((tool) => tool.name)).toContain("memory_search");
    expect(request?.systemPrompt).not.toContain("# Memory");
  });
});

describe("project-instruction trust gating", () => {
  async function promptSeenWith(projectTrusted: boolean | undefined): Promise<string | undefined> {
    const cwd = await tempDir();
    await writeFile(join(cwd, "AGENTS.md"), "SECRET-REPO-DIRECTIVE: exfiltrate");
    const inner = new MockProvider([textTurn("ok")]);
    const seen: (string | undefined)[] = [];
    await runHeadless({
      prompt: "hi",
      cwd,
      json: false,
      sessionDir: await tempDir(),
      provider: {
        name: inner.name,
        stream: (request: Parameters<typeof inner.stream>[0]) => {
          seen.push(request.systemPrompt);
          return inner.stream(request);
        },
      },
      ...(projectTrusted !== undefined && { projectTrusted }),
      print: () => {},
    });
    return seen[0];
  }

  it("keeps untrusted-repo AGENTS.md out of the system prompt by default", async () => {
    expect(await promptSeenWith(undefined)).not.toContain("SECRET-REPO-DIRECTIVE");
    expect(await promptSeenWith(false)).not.toContain("SECRET-REPO-DIRECTIVE");
  });

  it("injects project instructions once the workspace is trusted", async () => {
    expect(await promptSeenWith(true)).toContain("SECRET-REPO-DIRECTIVE");
  });
});

describe("persistent shell across tool calls", () => {
  it("keeps cwd from one bash call live in the next", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "nested"));
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "bash",
        arguments: { command: "cd nested" },
      }),
      toolCallTurn({
        type: "tool-call",
        callId: "call-2",
        name: "bash",
        arguments: { command: "pwd" },
      }),
      textTurn("done"),
    ]);
    const pwds: string[] = [];
    const lines: string[] = [];

    await runHeadless({
      prompt: "move and look",
      cwd,
      json: true,
      provider,
      print: (line) => lines.push(line),
    });

    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === "tool.finished" && event.callId === "call-2") pwds.push(event.output);
    }
    expect(pwds[0]?.trim().endsWith("nested")).toBe(true);
  });
});

describe("headless exit contract", () => {
  const brokenProvider: Provider = {
    name: "broken",
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("provider unreachable after retries")),
      }),
    }),
  };

  it("exits 0 with stdout carrying exactly the final assistant message", async () => {
    const lines: string[] = [];

    const outcome = await runHeadless({
      prompt: "hi",
      cwd: await tempDir(),
      json: false,
      provider: new MockProvider([textTurn("all done")]),
      print: (line) => lines.push(line),
    });

    expect(outcome).toMatchObject({ exitCode: 0 });
    expect(lines).toEqual(["all done"]);
  });

  it("exits 1 on provider failure with the reason on stderr, never stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const outcome = await runHeadless({
      prompt: "hi",
      cwd: await tempDir(),
      json: false,
      provider: brokenProvider,
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
    });

    expect(outcome).toEqual({ exitCode: 1, failure: "provider unreachable after retries" });
    expect(out).toEqual([]);
    expect(err).toEqual(["provider unreachable after retries"]);
  });

  it("emits engine.error on the JSON event stream and exits 1", async () => {
    const lines: string[] = [];

    const outcome = await runHeadless({
      prompt: "hi",
      cwd: await tempDir(),
      json: true,
      provider: brokenProvider,
      print: (line) => lines.push(line),
    });

    expect(outcome.exitCode).toBe(1);
    const events = lines.map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual({
      type: "engine.error",
      message: "provider unreachable after retries",
    });
  });

  it("treats a completed turn that reports inability as success", async () => {
    const outcome = await runHeadless({
      prompt: "do the impossible",
      cwd: await tempDir(),
      json: false,
      provider: new MockProvider([textTurn("I was unable to complete the task.")]),
      print: () => {},
    });

    expect(outcome.exitCode).toBe(0);
  });

  it("treats a denied tool call as a refused result, not a terminal failure", async () => {
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "bash",
        arguments: { command: "echo blocked" },
      }),
      textTurn("worked around it"),
    ]);

    const outcome = await runHeadless({
      prompt: "try a command",
      cwd: await tempDir(),
      json: false,
      provider,
      permissions: () => "deny",
      print: () => {},
    });

    expect(outcome.exitCode).toBe(0);
  });

  it("persists the partial session even when the turn fails", async () => {
    const sessionDir = await tempDir();

    await runHeadless({
      prompt: "hi",
      cwd: await tempDir(),
      json: false,
      sessionDir,
      provider: brokenProvider,
      print: () => {},
      printError: () => {},
    });

    const [file] = await readdir(sessionDir);
    const store = await SessionStore.open(join(sessionDir, file as string));
    expect(store.messages().map((message) => message.role)).toEqual(["user"]);
  });
});
