import { Agent, type Message, MockProvider, textMessage, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  attachOnFork,
  bindSessionLifecycle,
  crashLogFile,
  discardFrame,
  doctorCommand,
  paneSessionIndex,
  pointerPlaneId,
  type SessionAttachment,
  type SessionPort,
  seedArcFromOrigin,
  sessionEscrow,
  startFreshSession,
} from "./app.ts";
import type { ArcsPort } from "./arcs.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { AppProbe } from "./probe.ts";
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

describe("discardFrame", () => {
  function mountedFrame(childCount: number) {
    const destroyed: string[] = [];
    const mounted = Array.from({ length: childCount }, (_, ordinal) => {
      const child = {
        id: `renderable-${ordinal}`,
        destroyRecursively: () => {
          destroyed.push(child.id);
          mounted.splice(mounted.indexOf(child), 1);
        },
      };
      return child;
    });
    return { root: { getChildren: () => mounted }, mounted, destroyed };
  }

  it("destroys every renderable of the outgoing frame exactly once", () => {
    const frame = mountedFrame(3);

    discardFrame(frame.root);

    expect(frame.destroyed).toEqual(["renderable-0", "renderable-1", "renderable-2"]);
    expect(frame.mounted).toEqual([]);
  });

  it("is a no-op on an empty frame", () => {
    const frame = mountedFrame(0);
    discardFrame(frame.root);
    expect(frame.destroyed).toEqual([]);
  });

  it("never destroys the pointer plane, so mouse hits always resolve", () => {
    const frame = mountedFrame(2);
    let planeDestroyed = false;
    frame.mounted.push({
      id: pointerPlaneId,
      destroyRecursively: () => {
        planeDestroyed = true;
      },
    });

    discardFrame(frame.root);

    expect(planeDestroyed).toBe(false);
    expect(frame.destroyed).toEqual(["renderable-0", "renderable-1"]);
  });
});

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

describe("doctorCommand", () => {
  function doctorProbe(exists: boolean) {
    const opened: { path: string; atEnd: boolean }[] = [];
    const notices: string[] = [];
    const command = doctorCommand({
      logFile: crashLogFile,
      exists: () => exists,
      openFile: (path, options) => opened.push({ path, atEnd: options?.atEnd === true }),
      notice: (text) => notices.push(text),
    });
    return { command, opened, notices };
  }

  it("opens the crash log at its tail when crashes are recorded", () => {
    const { command, opened, notices } = doctorProbe(true);
    command.run();
    expect(opened).toEqual([{ path: crashLogFile, atEnd: true }]);
    expect(notices).toEqual([]);
  });

  it("posts a calm notice when there is no crash log", () => {
    const { command, opened, notices } = doctorProbe(false);
    command.run();
    expect(opened).toEqual([]);
    expect(notices).toEqual(["no crashes recorded · nothing to show"]);
  });
});

describe("seedArcFromOrigin (PD13 splits)", () => {
  function arcsOver(taken: string[]): { port: ArcsPort; created: string[] } {
    const created: string[] = [];
    return {
      created,
      port: {
        list: async () =>
          taken.map((slug) => ({ slug, status: "active", created: "", sessions: 0 })),
        create: async (slug) => {
          created.push(slug);
          return { slug, status: "active", created: "", sessions: 0 };
        },
        close: async () => ({ kind: "closed", delivered: 0, released: 0 }),
        abandon: async () => {},
      },
    };
  }

  function probeWithSource(arc: string | undefined): AppProbe {
    const probe = new AppProbe();
    const source = probe.core.panes.get("session-1");
    if (source instanceof ConversationPane) source.arc = arc;
    return probe;
  }

  it("does nothing without an origin", async () => {
    const bound: Array<string | undefined> = [];
    const notice = await seedArcFromOrigin(undefined, new AppProbe().core, undefined, async (s) => {
      bound.push(s);
    });
    expect(notice).toBeUndefined();
    expect(bound).toEqual([]);
  });

  it("inherits the source pane's arc on a regular split and stays unbound when the source is", async () => {
    const bound: Array<string | undefined> = [];
    const bind = async (slug: string | undefined): Promise<void> => {
      bound.push(slug);
    };
    const boundProbe = probeWithSource("dock-v2");
    await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "inherit" },
      boundProbe.core,
      undefined,
      bind,
    );
    expect(bound).toEqual(["dock-v2"]);
    const unboundProbe = probeWithSource(undefined);
    await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "inherit" },
      unboundProbe.core,
      undefined,
      bind,
    );
    expect(bound).toEqual(["dock-v2"]);
  });

  it("mints a fresh arc for split-arc, naming from the source title and skipping taken slugs", async () => {
    const bound: Array<string | undefined> = [];
    const { port, created } = arcsOver(["arc-1"]);
    const probe = probeWithSource("dock-v2");
    const notice = await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "new" },
      probe.core,
      port,
      async (slug) => {
        bound.push(slug);
      },
    );
    expect(created).toEqual(["arc-2"]);
    expect(bound).toEqual(["arc-2"]);
    expect(notice).toBe("arc → arc-2 · new");
  });

  it("explains itself when split-arc runs without an arcs port", async () => {
    const notice = await seedArcFromOrigin(
      { arc: "new" },
      new AppProbe().core,
      undefined,
      async () => {},
    );
    expect(notice).toContain("no arcs here");
  });
});

describe("resuming a session with no attachment", () => {
  it("posts a notice and opens no pane when the factory refuses the resume", () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands, resumeSessionId) =>
        resumeSessionId === undefined
          ? new ConversationPane(id, undefined, notify, undefined, commands)
          : undefined,
    });
    probe.core.intents.openSession("gone-1");
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1"]);
    expect(probe.snapshot().focused).toBe("session-1");
    expect(probe.snapshot().notice).toBe(
      "can't open session gone-1 · its store is missing or unreadable",
    );
    probe.command("split");
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1", "session-2"]);
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
