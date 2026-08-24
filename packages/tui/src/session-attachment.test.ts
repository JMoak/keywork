import {
  Agent,
  type Message,
  MockProvider,
  messageText,
  textMessage,
  textTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import { AppProbe } from "./probe.ts";
import {
  attachOnFork,
  bindSessionLifecycle,
  paneSessionIndex,
  type SessionAttachment,
  type SessionPort,
  sessionEscrow,
  startFreshSession,
} from "./session-attachment.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";

function attachmentOf(id: string): SessionAttachment {
  return { id, history: [], replay: () => {}, append: async () => undefined };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function releasingPort(released: string[]): SessionPort {
  return {
    open: async (id) => attachmentOf(id),
    create: async () => undefined,
    release: (sessionId) => {
      released.push(sessionId);
    },
  };
}

function forkingTrees(forkedId: string): SessionTreePort {
  return {
    load: async () => undefined,
    setLabel: async () => {},
    fork: async () => forkedId,
  };
}

describe("startFreshSession", () => {
  it("wires the created session while the pane is live", async () => {
    let wired: string | undefined;
    let release: (attachment: SessionAttachment | undefined) => void = () => {};
    startFreshSession(
      {
        open: async () => undefined,
        create: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      () => {},
      (attachment) => {
        wired = attachment.id;
      },
      () => true,
    );
    release(attachmentOf("s-live"));
    await flush();
    expect(wired).toBe("s-live");
  });

  it("discards and releases a session that lands after the pane was disposed", async () => {
    let wired = false;
    let notified = 0;
    const released: string[] = [];
    let release: (attachment: SessionAttachment | undefined) => void = () => {};
    startFreshSession(
      {
        open: async () => undefined,
        create: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        release: (sessionId) => {
          released.push(sessionId);
        },
      },
      () => {
        notified += 1;
      },
      () => {
        wired = true;
      },
      () => false,
    );
    release(attachmentOf("s-late"));
    await flush();
    expect(wired).toBe(false);
    expect(notified).toBe(0);
    expect(released).toEqual(["s-late"]);
  });
});

describe("sessionEscrow", () => {
  it("hands a held attachment to exactly one claimant", () => {
    const released: string[] = [];
    const escrow = sessionEscrow(releasingPort(released));
    const attachment = attachmentOf("s1");
    escrow.hold("s1", attachment);
    expect(escrow.claim("s1")).toBe(attachment);
    expect(escrow.claim("s1")).toBeUndefined();
    expect(released).toEqual([]);
  });

  it("releases an unclaimed attachment when the same session is held again", () => {
    const released: string[] = [];
    const escrow = sessionEscrow(releasingPort(released));
    escrow.hold("s1", attachmentOf("s1"));
    const fresher = attachmentOf("s1");
    escrow.hold("s1", fresher);
    expect(released).toEqual(["s1"]);
    expect(escrow.claim("s1")).toBe(fresher);
  });

  it("releases everything still held at shutdown", () => {
    const released: string[] = [];
    const escrow = sessionEscrow(releasingPort(released));
    escrow.hold("s1", attachmentOf("s1"));
    escrow.hold("s2", attachmentOf("s2"));
    escrow.claim("s2");
    escrow.releaseAll();
    expect(released).toEqual(["s1"]);
    expect(escrow.claim("s1")).toBeUndefined();
  });
});

describe("attachOnFork", () => {
  it("holds a forked attachment in escrow until a pane claims it", async () => {
    const released: string[] = [];
    const escrow = sessionEscrow(releasingPort(released));
    const port = attachOnFork(forkingTrees("forked-1"), releasingPort(released), escrow);

    const forkedId = await port.fork("s1", "e1");

    expect(forkedId).toBe("forked-1");
    expect(escrow.claim("forked-1")?.id).toBe("forked-1");
    expect(released).toEqual([]);
  });

  it("attach reports whether a session could be opened and holds what it opened", async () => {
    const escrow = sessionEscrow(undefined);
    const opening: SessionPort = {
      open: async (id) => (id === "gone" ? undefined : attachmentOf(id)),
      create: async () => undefined,
    };
    const port = attachOnFork(forkingTrees("forked-1"), opening, escrow);

    expect(await port.attach?.("gone")).toBe(false);
    expect(await port.attach?.("s2")).toBe(true);
    expect(escrow.claim("gone")).toBeUndefined();
    expect(escrow.claim("s2")?.id).toBe("s2");
  });

  it("forwards the tree port's subscribe seam", () => {
    const listeners: string[] = [];
    const trees: SessionTreePort = {
      ...forkingTrees("forked-1"),
      subscribe: (listener) => {
        listeners.push("subscribed");
        listener("s1");
        return () => {};
      },
    };
    const port = attachOnFork(trees, undefined, sessionEscrow(undefined));
    const seen: string[] = [];
    port.subscribe?.((sessionId) => seen.push(sessionId));
    expect(listeners).toEqual(["subscribed"]);
    expect(seen).toEqual(["s1"]);
  });
});

describe("paneSessionIndex", () => {
  it("releases a closed pane's session and prunes the index", () => {
    const released: string[] = [];
    const index = paneSessionIndex(releasingPort(released));
    index.bind("session-1", () => "s1");
    index.bind("session-2", () => undefined);
    expect(index.size()).toBe(2);

    index.closed("session-1");
    index.closed("session-2");

    expect(released).toEqual(["s1"]);
    expect(index.size()).toBe(0);
  });

  it("tolerates a port without release and unknown panes", () => {
    const index = paneSessionIndex({ open: async () => undefined, create: async () => undefined });
    index.bind("session-1", () => "s1");
    index.closed("session-1");
    index.closed("never-bound");
    expect(index.size()).toBe(0);
  });

  it("releases every bound session at shutdown so nothing outlives the app", () => {
    const released: string[] = [];
    const index = paneSessionIndex(releasingPort(released));
    index.bind("session-1", () => "s1");
    index.bind("session-2", () => "s2");
    index.bind("session-3", () => undefined);

    index.closeAll();

    expect(released.sort()).toEqual(["s1", "s2"]);
    expect(index.size()).toBe(0);
  });
});

describe("bindSessionLifecycle", () => {
  it("hands each persisted prompt's entry id back to the pane", async () => {
    let sequence = 0;
    const attachment: SessionAttachment = {
      id: "s1",
      history: [],
      replay: () => {},
      append: async (message) => {
        sequence += 1;
        return { entryId: `${message.role}-${sequence}` };
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const provider = new MockProvider([textTurn("reply"), textTurn("again")]);
        const pane = new ConversationPane(id, new Agent({ provider }), notify, undefined, commands);
        bindSessionLifecycle({ pane, attachment });
        return pane;
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    probe.type("two").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([
      { kind: "user", text: "one", entryId: "user-1" },
      { kind: "user", text: "two", entryId: "user-3" },
    ]);
  });

  it("retries from the first message whose append failed instead of skipping past it", async () => {
    const appended: string[] = [];
    let failOnce = true;
    const attachment: SessionAttachment = {
      id: "s1",
      history: [],
      replay: () => {},
      append: async (message) => {
        if (message.role === "assistant" && failOnce) {
          failOnce = false;
          throw new Error("disk full");
        }
        appended.push(`${message.role}:${messageText(message)}`);
        return undefined;
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const provider = new MockProvider([textTurn("reply"), textTurn("again")]);
        const pane = new ConversationPane(id, new Agent({ provider }), notify, undefined, commands);
        bindSessionLifecycle({ pane, attachment });
        return pane;
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    expect(appended).toEqual(["user:one"]);
    probe.type("two").keys("enter");
    await probe.settled();
    expect(appended).toEqual(["user:one", "assistant:reply", "user:two", "assistant:again"]);
  });

  it("persists a turn in flight at close but skips the agent swap", async () => {
    const appended: Message[] = [];
    const attachment: SessionAttachment = {
      id: "s1",
      history: [],
      replay: () => {},
      append: async (message) => {
        appended.push(message);
        return undefined;
      },
    };
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const next = new Agent({ provider: new MockProvider([]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    bindSessionLifecycle({
      pane,
      attachment,
      afterTurn: async ({ history }) => ({
        history: [...history, textMessage("user", "joined")],
        notices: [],
        flushed: [],
        compacted: undefined,
      }),
      rebuild: () => next,
    });
    pane.submitPrompt("go");
    pane.dispose();
    await pane.settled();
    expect(appended.length).toBeGreaterThan(0);
    expect(pane.currentAgent()).toBe(agent);
  });
});
