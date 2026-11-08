import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreatureHost,
  type CreatureThreads,
  childDirFor,
  creatureTagOf,
  hostWorkshop,
  inboundBlockHeading,
  keeperLedgerPath,
  type Message,
  MockProvider,
  type PermissionResolver,
  type Provider,
  type ReportMark,
  type SessionStore,
  type Setting,
  type StagedItem,
  SessionStore as Store,
  textTurn,
  toolCallTurn,
  type WorkshopView,
} from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { createKeyworkServer, EventLog, type SessionHost } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { nodePaths } from "./node/paths.ts";
import { servedHost } from "./serve.ts";
import {
  creatureSeats,
  creatureSessionsOver,
  finishThread,
  firstLineOf,
  firstSentenceOf,
  inboundSection,
  keptConversation,
  type ServedCreatureSessions,
  turnLabelOf,
} from "./serve-creatures.ts";
import { findSession, scanSessions } from "./sessions/store.ts";

const tempDir = scratchDirs("keywork-serve-creatures-");
const token = "creatures-token";

describe("a creature's sessions under keywork serve", () => {
  it("run inside the creature's workshop: a bare host one works in the workspace itself, started by the first call", async () => {
    const world = await creatureWorld(
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "from the workshop" },
        }),
        textTurn("written"),
      ]),
    );
    try {
      const workshop = await world.json<WorkshopView>("/workshops", {
        creature: "wren",
        substrate: "host",
      });
      await world.json("/creatures", { name: "Wren", workshop: workshop.id });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/wren");
      await world.host.prompt(conversation, "write hello.txt");
      await world.settled(conversation);

      const detail = await world.host.read(conversation);
      const results = (detail?.messages ?? []).flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "tool-result" ? [part.output] : [])),
      );
      expect(workshop.workdir).toBe(world.cwd);
      expect(results).toEqual([
        `workshop ${workshop.id} was stopped · started it for this call\nWrote hello.txt`,
      ]);
      expect(await readFile(join(world.cwd, "hello.txt"), "utf8")).toBe("from the workshop");
      expect((await world.json<WorkshopView>(`/workshops/${workshop.id}`)).state).toBe("running");
    } finally {
      await world.close();
    }
  });

  it("take their workshop with them when the creature goes, unless the keeper keeps it", async () => {
    const world = await creatureWorld(new MockProvider([]));
    try {
      const raised = async (creature: string) =>
        world.json<WorkshopView>("/workshops", { creature, substrate: "host" });
      const wren = await raised("wren");
      const moss = await raised("moss");
      await world.json("/creatures", { name: "Wren", workshop: wren.id });
      await world.json("/creatures", { name: "Moss", workshop: moss.id });

      await world.remove("/creatures/wren?confirmed=true");
      await world.remove("/creatures/moss?confirmed=true&keepWorkshop=true");

      const { workshops } = await world.json<{ workshops: WorkshopView[] }>("/workshops");
      expect(workshops.map((workshop) => workshop.id)).toEqual([moss.id]);
    } finally {
      await world.close();
    }
  });

  it("tags a child the conversation delegates to as the creature's child", async () => {
    const world = await creatureWorld(
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "d1",
          name: "delegate",
          arguments: { title: "look around", prompt: "list what you see" },
        }),
        textTurn("two files"),
        textTurn("done"),
      ]),
    );
    try {
      await world.json("/creatures", { name: "Pip" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/pip");
      await world.host.prompt(conversation, "delegate a look");
      await world.settled(conversation);

      const parent = await findSession(world.sessionDir, conversation);
      const { stores } = await scanSessions(childDirFor(parent?.file ?? ""));
      expect(stores).toHaveLength(1);
      expect(creatureTagOf(stores[0]?.entries() ?? [])).toEqual({ creature: "pip", kind: "child" });
      expect(stores[0]?.botBinding()).toBe("pip");
    } finally {
      await world.close();
    }
  });

  it("reports a finished thread to the conversation as one entry from the creature, starting no turn", async () => {
    const world = await creatureWorld(
      new MockProvider([textTurn("All three builds are green.\nDetails follow."), textTurn("ok")]),
    );
    try {
      await world.json("/creatures", { name: "Pip" });
      const creatures = world.host.creatures as CreatureHost;
      const thread = await creatures.openThread("pip", "thread");
      await world.host.rename(thread, "check the builds");
      await world.host.prompt(thread, "check the builds");
      const { conversation } = await world.json<{ conversation: string }>("/creatures/pip");
      const reports = async () =>
        ((await findSession(world.sessionDir, conversation))?.entries() ?? []).flatMap((entry) =>
          entry.type === "custom" && entry.customType === "keywork.creature.report"
            ? [entry.data]
            : [],
        );
      await world.until(async () => (await reports()).length > 0);

      expect(await reports()).toEqual([
        {
          text: 'Thread "check the builds" finished: All three builds are green.',
          origin: { kind: "creature", creature: "pip", thread },
        },
      ]);
      expect(await world.messagesOf(conversation)).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

describe("a message delivered to a creature", () => {
  it("reaches its next turn as an untrusted inbound block, once, replayed from the first-light run-5 journal", async () => {
    const provider = recordingProvider([
      textTurn(
        "Lark says the five largest docs are listed in notes/largest.md and asks me to check them.",
      ),
      textTurn("Nothing new."),
    ]);
    const world = await creatureWorld(provider, () => "allow", seedRun5Hal);
    try {
      const { conversation } = await world.json<{ conversation: string }>("/creatures/hal");
      expect(conversation).toBe(run5Conversation);
      await world.host.prompt(conversation, run5Prompt);
      await world.settled(conversation);

      const first = provider.requests[0];
      expect(first?.systemPrompt).toContain(
        [
          inboundBlockHeading,
          "- Message from lark: The five largest docs are listed in notes/largest.md; please check them when you can. [untrusted, 2026-11-06T15:59:54.670Z]",
        ].join("\n"),
      );
      expect(first?.messages.at(-1)).toEqual({
        role: "user",
        parts: [{ type: "text", text: run5Prompt }],
      });
      expect(
        first?.messages.some((message) => JSON.stringify(message).includes("Message from lark")),
      ).toBe(false);

      await world.host.prompt(conversation, "anything else?");
      await world.settled(conversation);
      expect(provider.requests[1]?.systemPrompt).not.toContain(inboundBlockHeading);
    } finally {
      await world.close();
    }
  });

  it("is sent with the message tool every creature seat carries, bound to that creature", async () => {
    const provider = recordingProvider([textTurn("hello")]);
    const world = await creatureWorld(provider);
    try {
      await world.json("/creatures", { name: "Lark" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/lark");
      await world.host.prompt(conversation, "say hello");
      await world.settled(conversation);
      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["schedule", "message"]),
      );
    } finally {
      await world.close();
    }

    const sent: unknown[] = [];
    const mail = {
      send: async (draft: unknown) => {
        sent.push(draft);
        return { refused: "missing" as const, error: "no creature here is called hal" };
      },
    };
    const store = await taggedStore({ creature: "lark", kind: "conversation" });
    const registry = {
      read: async () => ({
        slug: "lark",
        file: { introduction: "You are Lark.", workshop: hostWorkshop },
      }),
    };
    const seat = await creatureSeats({
      registry: registry as unknown as Parameters<typeof creatureSeats>[0]["registry"],
      workshops: {
        tools: async () => [],
        detail: async () => ({ refused: "missing", error: "none" }),
      },
      grants: () => [],
      mail: () => mail,
      notice: () => undefined,
    })(store);
    expect(seat?.message?.creature).toBe("lark");
    await seat?.message?.mail.send({ from: "lark", to: "hal", text: "hi" });
    expect(sent).toEqual([{ from: "lark", to: "hal", text: "hi" }]);
  });
});

describe("the show tool under keywork serve", () => {
  it("is offered to every served session: a plain conversation, a creature's conversation, its child and its chore run", async () => {
    const provider = recordingProvider([
      showTurn("p1", { kind: "note", ref: "Lunch at noon." }, "seen"),
      textTurn("Shown."),
      toolCallTurn({
        type: "tool-call",
        callId: "d1",
        name: "delegate",
        arguments: { title: "find the plan", prompt: "show the plan to the keeper" },
      }),
      showTurn("c1", { kind: "file", ref: "notes/plan.md" }, "seen"),
      textTurn("Set it out."),
      textTurn("The child set out the plan."),
      showTurn("r1", { kind: "report", ref: "r-triage" }, "rests"),
      textTurn("Triage done."),
    ]);
    const world = await creatureWorld(provider, () => undefined);
    try {
      const plain = (await world.host.create()).id;
      await world.host.prompt(plain, "remind me about lunch");
      await world.settled(plain);
      await world.json("/creatures", { name: "Pip" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/pip");
      await world.host.prompt(conversation, "delegate a look at the plan");
      await world.settled(conversation);
      const chore = await (world.host.creatures as CreatureHost).openThread("pip", "routine");
      await world.host.prompt(chore, "triage");
      await world.settled(chore);
      const shown = async () => (await world.json<{ settings: Setting[] }>("/show")).settings;
      await world.until(async () => (await shown()).length === 2);

      expect(provider.requests).toHaveLength(8);
      for (const request of provider.requests) {
        expect(request.tools.map((tool) => tool.name)).toContain("show");
      }
      expect(
        (await shown()).map(({ creature, sessionId, what }) => [creature, sessionId, what.ref]),
      ).toEqual([
        [null, plain, "Lunch at noon."],
        ["pip", conversation, "notes/plan.md"],
      ]);
      expect(
        world.log
          .since(0)
          .filter(({ sessionId, type }) => sessionId === chore && type.startsWith("show."))
          .map(({ type }) => type),
      ).toEqual(["show.proposed", "show.settled"]);
    } finally {
      await world.close();
    }
  });

  it("sets out from a conversation with no ask, withdraws its rests settings when the thread rests, and a removed thread's live ones", async () => {
    const provider = recordingProvider([
      showTurn("v1", { kind: "file", ref: "notes/working.md" }, "rests"),
      showTurn("v2", { kind: "file", ref: "notes/plan.md" }, "seen"),
      textTurn("Set out the plan."),
      showTurn("v3", { kind: "report", ref: "r1" }, "seen"),
      textTurn("Set out the report."),
    ]);
    const world = await creatureWorld(provider, () => undefined);
    try {
      await world.json("/creatures", { name: "Pip" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/pip");
      const shown = async () => (await world.json<{ settings: Setting[] }>("/show")).settings;
      const refs = async () => (await shown()).map(({ what }) => what.ref);

      await world.host.prompt(conversation, "show me the plan");
      await world.settled(conversation);
      await world.until(async () => (await refs()).join() === "notes/plan.md");

      const creatures = world.host.creatures as CreatureHost;
      const thread = await creatures.openThread("pip", "thread");
      await world.host.prompt(thread, "show me the report");
      await world.settled(thread);
      expect(await refs()).toEqual(["notes/plan.md", "r1"]);
      await world.remove(`/sessions/${thread}`);

      expect(await shown()).toEqual([
        expect.objectContaining({ creature: "pip", sessionId: conversation, state: "live" }),
      ]);
      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("show");
      const shows = world.log
        .since(0)
        .filter(({ type }) => type.startsWith("show."))
        .map(({ sessionId, type, payload }) =>
          type === "show.settled"
            ? { sessionId, type, ...(payload as object) }
            : { sessionId, type, ref: (payload as { setting: Setting }).setting.what.ref },
        );
      expect(shows).toEqual([
        { sessionId: conversation, type: "show.proposed", ref: "notes/working.md" },
        { sessionId: conversation, type: "show.proposed", ref: "notes/plan.md" },
        {
          sessionId: conversation,
          type: "show.settled",
          id: expect.any(String),
          outcome: "withdrawn",
          by: "creature",
        },
        { sessionId: thread, type: "show.proposed", ref: "r1" },
        {
          sessionId: thread,
          type: "show.settled",
          id: expect.any(String),
          outcome: "withdrawn",
          by: "keeper",
        },
      ]);
    } finally {
      await world.close();
    }
  });
});

function showTurn(callId: string, what: { kind: string; ref: string }, until: string) {
  return toolCallTurn({
    type: "tool-call",
    callId,
    name: "show",
    arguments: { what, why: "The keeper asked for it.", until },
  });
}

describe("a finished conversation turn", () => {
  it("writes one report line from the creature, served as reports, with no further turn", async () => {
    const provider = recordingProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "w1",
        name: "write",
        arguments: { path: "notes/largest.md", content: "five files" },
      }),
      textTurn("I wrote the five largest files to notes/largest.md. They are all research notes."),
      textTurn("never asked for"),
    ]);
    const world = await creatureWorld(provider);
    try {
      await world.json("/creatures", { name: "Hal" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/hal");
      await world.host.prompt(conversation, "list the five largest files under docs");
      await world.settled(conversation);
      const reports = async () =>
        (await world.json<{ reports: ReportMark[] }>(`/sessions/${conversation}`)).reports;
      await world.until(async () => (await reports()).length > 0);

      expect(await reports()).toEqual([
        {
          index: 4,
          entryId: expect.any(String),
          at: expect.any(String),
          text: "I wrote the five largest files to notes/largest.md.",
          origin: { kind: "creature", creature: "hal", thread: conversation },
        },
      ]);
      expect(provider.requests).toHaveLength(2);
    } finally {
      await world.close();
    }
  });
});

describe("the keeper's answers to a creature", () => {
  it("land in the node's decision ledger with the creature and the thread kind", async () => {
    const world = await creatureWorld(
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "w1",
          name: "write",
          arguments: { path: "plan.md", content: "the plan" },
        }),
        textTurn("saved the plan"),
      ]),
      () => undefined,
    );
    try {
      await world.json("/creatures", { name: "Pip" });
      const { conversation } = await world.json<{ conversation: string }>("/creatures/pip");
      await world.host.prompt(conversation, "save the plan");
      await world.until(async () => (await world.host.asks()).length > 0);
      const [ask] = await world.host.asks();
      expect(await world.host.answerAsk(ask?.callId ?? "", "granted", "once")).toBe("settled");
      await world.settled(conversation);
    } finally {
      await world.close();
    }

    const ledger = await readFile(keeperLedgerPath(nodePaths(world.userRoot).state), "utf8");
    expect(ledger).toContain("creature:pip");
    expect(ledger).toContain("conversation");
  });
});

describe("the conversation guard", () => {
  it("keeps only the conversation of a creature that still exists", async () => {
    const conversation = await taggedStore({ creature: "pip", kind: "conversation" });
    const thread = await taggedStore({ creature: "pip", kind: "thread" });
    const threads = { conversations: async () => new Set([conversation.header.id]) };
    const kept = keptConversation(threads, async (slug) => slug === "pip");

    expect(await kept(conversation.header.id, conversation)).toBe(
      "the conversation of pip stays while the creature does · removing the creature removes it",
    );
    expect(await kept(thread.header.id, thread)).toBeUndefined();
    const gone = keptConversation(threads, async () => false);
    expect(await gone(conversation.header.id, conversation)).toBeUndefined();
    const duplicate = keptConversation(
      { conversations: async () => new Set<string>() } satisfies Pick<
        CreatureThreads,
        "conversations"
      >,
      async () => true,
    );
    expect(await duplicate(conversation.header.id, conversation)).toBeUndefined();
  });
});

describe("a creature's session listing", () => {
  it("lists only tagged sessions, with their parent, work and waiting asks", async () => {
    const conversation = await taggedStore({ creature: "pip", kind: "conversation" });
    const child = await taggedStore({ creature: "pip", kind: "child" }, conversation.header.id);
    const plain = await Store.create(join(await tempDir(), "plain.jsonl"), "/work");
    const served: ServedCreatureSessions = {
      stored: async () => [conversation, child, plain],
      working: (id) => id === conversation.header.id,
      waiting: (id) => (id === child.header.id ? 2 : 0),
      openClaimed: async () => "new",
      inject: async () => "started",
      trash: async () => undefined,
    };

    const listed = await creatureSessionsOver(served).list();

    expect(
      listed.map(({ id, tag, working, waiting, parent }) => ({
        id,
        tag,
        working,
        waiting,
        parent,
      })),
    ).toEqual([
      {
        id: conversation.header.id,
        tag: { creature: "pip", kind: "conversation" },
        working: true,
        waiting: 0,
        parent: undefined,
      },
      {
        id: child.header.id,
        tag: { creature: "pip", kind: "child" },
        working: false,
        waiting: 2,
        parent: conversation.header.id,
      },
    ]);
  });
});

describe("finishing a thread", () => {
  it("reports threads only, with the thread's title and the first line of its last reply", async () => {
    const finished: unknown[] = [];
    const creatures = {
      finish: async (...args: unknown[]) => {
        finished.push(args);
        return "queued" as const;
      },
      deliver: async () => "noted" as const,
    };
    const thread = await taggedStore({ creature: "pip", kind: "thread" });
    await thread.setName("tidy the notes");
    const routine = await taggedStore({ creature: "pip", kind: "routine" });

    expect(
      await finishThread(creatures, {
        id: thread.header.id,
        store: thread,
        outcome: "interrupted",
        lastReply: "\nHalfway there.\nMore later.",
      }),
    ).toBe("queued");
    expect(
      await finishThread(creatures, {
        id: routine.header.id,
        store: routine,
        outcome: "completed",
        lastReply: "x",
      }),
    ).toBeUndefined();
    expect(finished).toEqual([
      [
        "pip",
        thread.header.id,
        { title: "tidy the notes", outcome: "interrupted", summary: "Halfway there." },
      ],
    ]);
  });

  it("reports a completed conversation turn as one line from the creature: its first sentence, else the files it changed", async () => {
    const delivered: unknown[] = [];
    const creatures = {
      finish: async () => "noted" as const,
      deliver: async (...args: unknown[]) => {
        delivered.push(args);
        return "noted" as const;
      },
    };
    const conversation = await taggedStore({ creature: "pip", kind: "conversation" });
    const settled = (outcome: "completed" | "failed", lastReply: string) => ({
      id: conversation.header.id,
      store: conversation,
      outcome,
      lastReply,
    });
    const origin = { kind: "creature", creature: "pip", thread: conversation.header.id };

    expect(
      await finishThread(
        creatures,
        settled(
          "completed",
          "I listed the five largest files in notes/largest.md. Next, the rest.",
        ),
      ),
    ).toBe("noted");
    expect(
      await finishThread(creatures, settled("failed", "the provider refused")),
    ).toBeUndefined();
    await conversation.appendCustom("turn_facts", {
      prompt: "p1",
      files: [{ path: "notes/largest.md", added: 7, deleted: 0 }],
    });
    await finishThread(creatures, settled("completed", ""));
    expect(delivered).toEqual([
      ["pip", "I listed the five largest files in notes/largest.md.", origin],
      ["pip", "Changed notes/largest.md.", origin],
    ]);
  });

  it("labels a turn by its first sentence, keeping dots inside words", async () => {
    expect(firstSentenceOf("Wrote notes/largest.md. Then stopped.")).toBe(
      "Wrote notes/largest.md.",
    );
    expect(firstSentenceOf("\nNo full stop here")).toBe("No full stop here");
    const empty = await taggedStore({ creature: "pip", kind: "conversation" });
    expect(turnLabelOf({ store: empty, lastReply: "" })).toBe("Finished the turn without a word.");
  });

  it("takes the first line with words in it", () => {
    expect(firstLineOf("\n  \nfirst\nsecond")).toBe("first");
    expect(firstLineOf("")).toBe("");
  });
});

async function taggedStore(
  tag: { creature: string; kind: "conversation" | "thread" | "routine" | "child" },
  parent?: string,
): Promise<SessionStore> {
  const dir = await tempDir();
  const store =
    parent === undefined
      ? await Store.create(join(dir, "s.jsonl"), "/work")
      : Store.createChild(join(dir, "c.jsonl"), "/work", { sessionId: parent, callId: "c1" });
  await store.appendBotBinding(tag.creature);
  await store.appendCustom("keywork.creature", tag);
  return store;
}

const run5Conversation = "6315bf76-8482-4dfc-80e2-5d28a7bcfaf9";

const run5Prompt =
  "what did Lark tell you? then wake yourself in 20 minutes to check this note again";

const run5Journal = fileURLToPath(
  new URL("./fixtures/first-light-run-5/hal-conversation.jsonl", import.meta.url),
);

async function seedRun5Hal(place: { cwd: string; sessionDir: string }): Promise<void> {
  const bot = join(place.cwd, ".keywork", "bots", "hal");
  await mkdir(bot, { recursive: true });
  const hal = {
    name: "Hal",
    created: "2026-11-06T15:22:23.567Z",
    introduction:
      "You are Hal, moakj's creature; you keep work moving between conversations and you ask before anything that cannot be undone.",
    body: { skin: "kid", seed: 0 },
    workshop: hostWorkshop,
    models: { strong: "inherit", loop: "inherit", decide: "inherit", vision: "inherit" },
    routines: "routines",
  };
  await writeFile(join(bot, "creature.json"), JSON.stringify(hal, null, 2));
  await writeFile(join(bot, "bot.md"), '---\nlearning: "notes"\n---\n');
  await copyFile(run5Journal, join(place.sessionDir, "1793978543601-0001-40008.jsonl"));
}

async function creatureWorld(
  provider: Provider,
  permissions: PermissionResolver = () => "allow",
  seed?: (place: { cwd: string; sessionDir: string }) => Promise<void>,
) {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "creatures" }));
  const sessionDir = await tempDir();
  const userRoot = await tempDir();
  await seed?.({ cwd, sessionDir });
  const log = new EventLog();
  const host: SessionHost = await servedHost({
    cwd,
    sessionDir,
    userRoot,
    projectTrusted: true,
    provider,
    permissions,
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const json = async <Shape>(path: string, body?: unknown): Promise<Shape> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  const remove = async (path: string): Promise<void> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
  };
  const messagesOf = async (id: string): Promise<readonly Message[]> => {
    const detail = await host.read(id);
    return detail?.messages ?? [];
  };
  const until = async (done: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + waitLimitMs;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error("the creature never got there");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    cwd,
    sessionDir,
    userRoot,
    host,
    log,
    json,
    remove,
    messagesOf,
    until,
    settled: (id: string) =>
      until(async () => (await host.list()).some((row) => row.id === id && !row.working)),
    close: () => server.close(),
  };
}

const waitLimitMs = 3_000;

describe("the inbound section of a creature's turn", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const said = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const stagedFor = (addressee: "keeper" | `creature:${string}`, created: string): StagedItem => ({
    id: `${addressee}-${created}`,
    kind: "note",
    target: "Fetched Pricing.md",
    created,
    source: "web:example.com",
    for: addressee,
    content: "---\nprovenance: untrusted\n---\nPrices from the vendor page\n",
  });

  it("quotes a note staged for this creature since its last turn, once, under the inbound heading", async () => {
    const conversation = await Store.create(join(await tempDir(), "cob.jsonl"), "/work");
    await conversation.append(said("first"));
    await tick();
    const at = new Date().toISOString();
    const staged = [
      stagedFor("creature:cob", at),
      stagedFor("keeper", at),
      stagedFor("creature:wren", at),
    ];
    await tick();
    await conversation.append(said("what did the page say?"));

    expect(inboundSection("cob", conversation.contextEntries(), staged)).toBe(
      `${inboundBlockHeading}\n- Staged from web:example.com: Prices from the vendor page [untrusted, ${at}]`,
    );

    await tick();
    await conversation.append(said("and now?"));
    expect(inboundSection("cob", conversation.contextEntries(), staged)).toBe("");
  });
});
