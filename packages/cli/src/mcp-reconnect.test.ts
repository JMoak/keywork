import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerNotFoundError, MockProvider } from "@keywork/engine";
import { createKeyworkServer, EventLog, keyworkClient, type McpPort } from "@keywork/server";
import { memorySessionHost } from "@keywork/server/testing";
import { afterAll, describe, expect, it } from "vitest";
import { describeReconnect, reconnectOnRunningServer } from "./mcp-reconnect.ts";

const root = await mkdtemp(join(tmpdir(), "keywork-mcp-reconnect-"));
const token = "reconnect-token";

afterAll(() => rm(root, { recursive: true, force: true }));

describe("reconnecting an MCP server on the running keywork server after login", () => {
  it("restarts the named server through the running server's API and reports its status", async () => {
    const registry = fakeRegistry();
    const world = runningServer(registry.port);
    try {
      const outcome = await reconnectOnRunningServer("github", world.client);
      expect(outcome).toEqual({
        kind: "reconnected",
        status: {
          name: "github",
          state: "connected",
          enabled: true,
          toolCount: 2,
          auth: "signed-in",
        },
      });
      expect(registry.calls).toEqual(["restart"]);
      expect(describeReconnect("github", outcome)).toBe(
        "github reconnected on the running keywork server · connected · signed in",
      );
    } finally {
      await world.close();
    }
  });

  it("says when no server is running, and when the running server could not reconnect", async () => {
    const quiet = await reconnectOnRunningServer("github", undefined);
    expect(quiet).toEqual({ kind: "no-server" });
    expect(describeReconnect("github", quiet)).toBe(
      "no keywork server is running for this workspace · restart github from the mcp pane, or relaunch keywork, to use it",
    );

    const world = runningServer(fakeRegistry().port);
    try {
      const failed = await reconnectOnRunningServer("ghost", world.client);
      expect(failed).toMatchObject({ kind: "failed", reason: expect.stringContaining("ghost") });
      expect(describeReconnect("ghost", failed)).toMatch(
        /^the running keywork server could not reconnect ghost \(.*ghost.*\) · restart it from the mcp pane$/,
      );
    } finally {
      await world.close();
    }
  });
});

function runningServer(mcp: McpPort) {
  const log = new EventLog();
  const host = memorySessionHost({
    log,
    provider: new MockProvider([]),
    surfaces: { root, mcp },
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const client = keyworkClient(
    { url: "http://keywork.test", token },
    { fetch: (input, init) => server.fetch(new Request(input, init)) },
  );
  return { client, close: () => server.close() };
}

function fakeRegistry() {
  const calls: string[] = [];
  let state: "connected" | "down" = "down";
  const status = () => ({
    name: "github",
    state,
    enabled: true,
    toolCount: state === "connected" ? 2 : 0,
    auth: "signed-in" as const,
  });
  const port: McpPort = {
    status: async () => [status()],
    restart: async (name) => {
      if (name !== "github") throw new McpServerNotFoundError(name);
      calls.push("restart");
      state = "connected";
    },
    setEnabled: async () => undefined,
    listTools: async () => [],
    subscribe: () => () => undefined,
  };
  return { port, calls };
}
