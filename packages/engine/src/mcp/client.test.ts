import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processExists } from "../proc.ts";
import {
  connectStdioServer,
  McpAbortedError,
  type McpConnection,
  McpRequestTimeoutError,
  McpServerExitedError,
  type StdioServerSpec,
} from "./client.ts";

const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));

function fixtureSpec(profile: string): StdioServerSpec {
  return { command: process.execPath, args: [fixturePath, profile] };
}

async function recordedPids(marker: string): Promise<number[]> {
  return (await readFile(marker, "utf8"))
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withConnection(
  profile: string,
  body: (connection: McpConnection) => Promise<void>,
): Promise<void> {
  const connection = await connectStdioServer(fixtureSpec(profile), { requestTimeoutMs: 5_000 });
  try {
    await body(connection);
  } finally {
    await connection.close();
  }
}

describe("stdio MCP client", () => {
  it("handshakes and lists tools across pagination", async () => {
    await withConnection("basic", async (connection) => {
      expect(connection.serverName).toBe("fixture-basic");
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo", "add"]);
      expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
    });
  });

  it("round-trips tool calls", async () => {
    await withConnection("basic", async (connection) => {
      const echoed = await connection.callTool("echo", { text: "hello mcp" });
      expect(echoed).toEqual({ text: "hello mcp", isError: false });
      const sum = await connection.callTool("add", { a: 2, b: 3 });
      expect(sum.text).toBe("5");
    });
  });

  it("reports unknown tools as error results", async () => {
    await withConnection("basic", async (connection) => {
      const result = await connection.callTool("missing", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no such tool");
    });
  });

  it("survives garbage and partial lines on stdout", async () => {
    await withConnection("garbage", async (connection) => {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo", "add"]);
      const echoed = await connection.callTool("echo", { text: "still works" });
      expect(echoed.text).toBe("still works");
    });
  });

  it("times out against a server that never handshakes", async () => {
    await expect(
      connectStdioServer(fixtureSpec("silent"), { requestTimeoutMs: 200 }),
    ).rejects.toBeInstanceOf(McpRequestTimeoutError);
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      connectStdioServer(
        { command: "keywork-definitely-not-a-real-binary" },
        { requestTimeoutMs: 2_000 },
      ),
    ).rejects.toThrow();
  });

  it("kills the whole process tree on close, grandchildren included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keywork-mcp-"));
    try {
      const marker = join(dir, "pids");
      const connection = await connectStdioServer(
        { command: process.execPath, args: [fixturePath, "leaky", marker] },
        { requestTimeoutMs: 5_000 },
      );
      const pids = await recordedPids(marker);
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(processExists(pid)).toBe(true);
      await connection.close();
      for (const pid of pids) await waitForGone(pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts a hung handshake without waiting out the request timeout", async () => {
    const controller = new AbortController();
    const connecting = connectStdioServer(fixtureSpec("silent"), {
      requestTimeoutMs: 8_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const begun = Date.now();
    await expect(connecting).rejects.toBeInstanceOf(McpAbortedError);
    expect(Date.now() - begun).toBeLessThan(4_000);
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectStdioServer(fixtureSpec("basic"), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(McpAbortedError);
  });

  it("abort after a successful connect is inert once the connection is closed", async () => {
    const controller = new AbortController();
    const connection = await connectStdioServer(fixtureSpec("basic"), {
      requestTimeoutMs: 5_000,
      signal: controller.signal,
    });
    const echoed = await connection.callTool("echo", { text: "pre-abort" });
    expect(echoed.text).toBe("pre-abort");
    await connection.close();
    controller.abort();
    await connection.close();
  });

  it("fails in-flight calls cleanly when the server crashes mid-call", async () => {
    const connection = await connectStdioServer(fixtureSpec("hazard"), {
      requestTimeoutMs: 5_000,
    });
    let closeError: Error | undefined;
    connection.onClose((error) => {
      closeError = error;
    });
    await expect(connection.callTool("boom", {})).rejects.toBeInstanceOf(McpServerExitedError);
    expect(closeError).toBeInstanceOf(McpServerExitedError);
    await expect(connection.callTool("echo", {})).rejects.toBeInstanceOf(McpServerExitedError);
    await connection.close();
  });
});
