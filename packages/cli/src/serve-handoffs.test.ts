import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureHandoff,
  MockProvider,
  type Provider,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { servedHost } from "./serve.ts";

const tempDir = scratchDirs("keywork-serve-handoffs-");
const token = "handoffs-token";
const waitLimitMs = 3_000;

describe("hand-offs under keywork serve", () => {
  it("count a message one creature delivers to another, keep the count across a restart and drop it with a removed creature", async () => {
    const place = await steadPlace();
    const first = await steadAt(
      place,
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "m1",
          name: "message",
          arguments: { to: "hal", text: "The largest docs are listed in notes/largest.md." },
        }),
        textTurn("Told Hal."),
      ]),
    );
    let counted: CreatureHandoff[];
    try {
      await first.call("POST", "/creatures", { name: "Lark" });
      await first.call("POST", "/creatures", { name: "Hal" });
      const { conversation } = await first.call<{ conversation: string }>("GET", "/creatures/lark");
      await first.host.prompt(conversation, "tell hal where the docs are");
      await first.settled(conversation);

      counted = (await first.call<{ handoffs: CreatureHandoff[] }>("GET", "/creature-handoffs"))
        .handoffs;
      expect(counted).toEqual([{ from: "lark", to: "hal", count: 1, lastAt: expect.any(String) }]);
      expect(first.handoffEvents()).toEqual([{ change: "counted", handoff: counted[0] }]);
    } finally {
      await first.close();
    }

    const second = await steadAt(place, new MockProvider([]));
    try {
      expect(await second.call("GET", "/creature-handoffs")).toEqual({ handoffs: counted });
      await second.call("DELETE", "/creatures/hal?confirmed=true");
      expect(await second.call("GET", "/creature-handoffs")).toEqual({ handoffs: [] });
      expect(second.handoffEvents()).toEqual([{ change: "dropped", handoff: counted[0] }]);
    } finally {
      await second.close();
    }

    const third = await steadAt(place, new MockProvider([]));
    try {
      expect(await third.call("GET", "/creature-handoffs")).toEqual({ handoffs: [] });
    } finally {
      await third.close();
    }
  });
});

interface SteadPlace {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

async function steadPlace(): Promise<SteadPlace> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "handoffs" }));
  return { cwd, sessionDir: await tempDir(), userRoot: await tempDir() };
}

async function steadAt(place: SteadPlace, provider: Provider) {
  const log = new EventLog();
  const host = await servedHost({
    ...place,
    projectTrusted: true,
    provider,
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const call = async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  const settled = async (id: string): Promise<void> => {
    const deadline = Date.now() + waitLimitMs;
    while (!(await host.list()).some((row) => row.id === id && !row.working)) {
      if (Date.now() > deadline) throw new Error("the turn never settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    host,
    call,
    settled,
    handoffEvents: () =>
      log
        .since(0)
        .filter((envelope) => envelope.type === "creature.handoff")
        .map((envelope) => envelope.payload),
    close: () => server.close(),
  };
}
