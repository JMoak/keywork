import {
  type EngineEvents,
  EventBus,
  MockProvider,
  type Provider,
  type ProviderRequest,
  type Tool,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog, type KeyworkClient, keyworkClient } from "@keywork/server";
import { memorySessionHost } from "@keywork/server/testing";
import { describe, expect, it } from "vitest";
import {
  remoteAgentFactory,
  remoteSessionPort,
  remoteSessionTreePort,
  replayMessages,
  type ServerFeed,
  serverFeed,
} from "./remote-ports.ts";

const token = "remote-ports-token";

interface Harness {
  client: KeyworkClient;
  feed: ServerFeed;
  close(): Promise<void>;
}

function harness(provider: Provider, tools: readonly Tool[] = []): Harness {
  const log = new EventLog();
  const host = memorySessionHost({ log, provider, tools });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const client = keyworkClient(
    { url: "http://keywork.test", token },
    { fetch: (input, init) => server.fetch(new Request(input, init)) },
  );
  const feed = serverFeed(client);
  return {
    client,
    feed,
    close: async () => {
      feed.close();
      await server.close();
    },
  };
}

type Recorded = { type: keyof EngineEvents; payload: unknown };

function recordingBus(): { bus: EventBus<EngineEvents>; seen: Recorded[] } {
  const bus = new EventBus<EngineEvents>();
  const seen: Recorded[] = [];
  const types: Array<keyof EngineEvents> = [
    "turn.started",
    "turn.delta",
    "turn.completed",
    "turn.interrupted",
    "tool.started",
    "tool.finished",
    "gate.permission",
    "engine.error",
  ];
  for (const type of types) bus.on(type, (payload) => seen.push({ type, payload }));
  return { bus, seen };
}

const echo: Tool = {
  name: "echo",
  description: "echoes its arguments",
  parameters: { type: "object" },
  execute: async (args) => JSON.stringify(args),
};

const writer: Tool = {
  name: "write",
  description: "would mutate the tree",
  parameters: { type: "object" },
  mutates: true,
  execute: async () => "wrote",
};

describe("remoteAgentFactory", () => {
  it("sends a prompt to the server and replays its turn onto the pane's bus in local order", async () => {
    const h = harness(
      new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { n: 1 } }),
        textTurn("all done"),
      ]),
      [echo],
    );
    const session = await remoteSessionPort(h.client).create();
    const { bus, seen } = recordingBus();
    const agent = remoteAgentFactory(h.client, h.feed)({}, [], {
      sessionId: () => session?.id,
      discloseRetrieval: () => {},
      bus,
    });

    const reply = await agent.send("echo one");

    expect(reply.parts).toEqual([{ type: "text", text: "all done" }]);
    const types = seen.map((event) => event.type);
    expect(types[0]).toBe("turn.started");
    expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    expect(types.at(-1)).toBe("turn.completed");
    expect(types.indexOf("tool.finished")).toBeLessThan(types.lastIndexOf("turn.delta"));
    expect(seen[0]?.payload).toEqual({ userText: "echo one" });
    expect(agent.busy()).toBe(false);
    const served = await h.client.session(session?.id ?? "");
    expect(agent.history()).toEqual(served?.messages);
    expect(agent.history().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    await h.close();
  });

  it("surfaces the server's headless refusal of an ask as the flagged tool failure it is", async () => {
    const h = harness(
      new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "w1", name: "write", arguments: {} }),
        textTurn("could not write"),
      ]),
      [writer],
    );
    const session = await remoteSessionPort(h.client).create();
    const { bus, seen } = recordingBus();
    const agent = remoteAgentFactory(h.client, h.feed)({}, [], {
      sessionId: () => session?.id,
      discloseRetrieval: () => {},
      bus,
    });

    await agent.send("write something");

    const gate = seen.find((event) => event.type === "gate.permission")?.payload as
      | EngineEvents["gate.permission"]
      | undefined;
    expect(gate?.decision).toMatchObject({ tool: "write", verdict: "denied", gate: "headless" });
    const finished = seen.find((event) => event.type === "tool.finished")?.payload as
      | EngineEvents["tool.finished"]
      | undefined;
    expect(finished?.isError).toBe(true);
    expect(finished?.output).toContain("not approved");
    await h.close();
  });

  it("forwards interrupt to the abort route and settles the turn as interrupted", async () => {
    const h = harness(hangingProvider());
    const session = await remoteSessionPort(h.client).create();
    const { bus, seen } = recordingBus();
    const agent = remoteAgentFactory(h.client, h.feed)({}, [], {
      sessionId: () => session?.id,
      discloseRetrieval: () => {},
      bus,
    });
    const firstDelta = new Promise<void>((resolve) => bus.on("turn.delta", () => resolve()));

    const settled = agent.send("wait forever");
    await firstDelta;
    expect(agent.busy()).toBe(true);
    agent.interrupt();
    await settled;

    expect(seen.at(-1)?.type).toBe("turn.interrupted");
    expect(agent.busy()).toBe(false);
    await h.close();
  });

  it("refuses to send before the pane has a server session", async () => {
    const h = harness(new MockProvider([]));
    const agent = remoteAgentFactory(h.client, h.feed)({}, [], {
      sessionId: () => undefined,
      discloseRetrieval: () => {},
    });
    await expect(agent.send("hello")).rejects.toThrow("no server session");
    await h.close();
  });
});

describe("remoteSessionPort", () => {
  it("opens a served session with its history and replays it onto a bus", async () => {
    const h = harness(new MockProvider([textTurn("first reply")]));
    const port = remoteSessionPort(h.client);
    const created = await port.create();
    expect(created?.history).toEqual([]);
    expect(created?.name).toBe(`session ${created?.id}`);
    const done = settledTurn(h.feed);
    await h.client.prompt(created?.id ?? "", "first prompt");
    await done;

    const reopened = await port.open(created?.id ?? "");
    expect(reopened?.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    const { bus, seen } = recordingBus();
    reopened?.replay(bus);
    expect(seen.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.delta",
      "turn.completed",
    ]);
    expect(seen.every((event) => (event.payload as { replay?: boolean }).replay === true)).toBe(
      true,
    );
    expect(await port.open("nope")).toBeUndefined();
    await h.close();
  });

  it("replays tool rounds as started and finished pairs", () => {
    const { bus, seen } = recordingBus();
    replayMessages(
      [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          parts: [{ type: "tool-call", callId: "c1", name: "echo", arguments: {} }],
        },
        {
          role: "tool",
          parts: [{ type: "tool-result", callId: "c1", output: "{}", isError: false }],
        },
        { role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
      bus,
    );
    expect(seen.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.delta",
      "tool.started",
      "tool.finished",
      "turn.delta",
      "turn.completed",
    ]);
  });
});

describe("remoteSessionTreePort", () => {
  it("lists served sessions, renders one as a linear tree, and refuses edits", async () => {
    const h = harness(new MockProvider([textTurn("reply")]));
    const trees = remoteSessionTreePort(h.client, h.feed);
    const changed: string[] = [];
    trees.subscribe?.((sessionId) => changed.push(sessionId));
    const created = await h.client.createSession();
    const done = settledTurn(h.feed);
    await h.client.prompt(created.id, "hello");
    await done;

    const overview = await trees.overview?.();
    expect(overview?.map((item) => [item.id, item.entryCount])).toEqual([[created.id, 2]]);
    const view = await trees.load(created.id);
    expect(view?.sessionId).toBe(created.id);
    expect(view?.roots).toHaveLength(1);
    expect(view?.roots[0]?.children[0]?.entry.parentId).toBe(view?.roots[0]?.entry.id);
    expect(view?.roots[0]?.children[0]?.children).toEqual([]);
    expect(await trees.load("nope")).toBeUndefined();
    await expect(trees.setLabel(created.id, "x", "label")).rejects.toThrow("while attached");
    await expect(trees.fork(created.id, "x")).rejects.toThrow("while attached");
    expect(changed).toEqual([created.id]);
    await h.close();
  });
});

function settledTurn(feed: ServerFeed): Promise<void> {
  return new Promise((resolve) => {
    const stop = feed.subscribe((envelope) => {
      if (envelope.type !== "turn.completed") return;
      stop();
      resolve();
    });
  });
}

function hangingProvider(): Provider {
  return {
    name: "hanging",
    async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
      yield { type: "text", text: "..." };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      request.signal?.throwIfAborted();
    },
  };
}
