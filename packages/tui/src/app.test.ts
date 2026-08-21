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
  startFreshSession,
} from "./app.ts";
import { ConversationPane } from "./conversation-pane.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";

function attachmentOf(id: string): SessionAttachment {
  return { id, history: [], replay: () => {}, append: async () => {} };
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

describe("attachOnFork", () => {
  it("disposes a forked attachment nobody claims", async () => {
    const attachments = new Map<string, SessionAttachment>();
    const released: string[] = [];
    const port = attachOnFork(forkingTrees("forked-1"), releasingPort(released), attachments);

    const forkedId = await port.fork("s1", "e1");

    expect(forkedId).toBe("forked-1");
    expect(attachments.has("forked-1")).toBe(true);
    await flush();
    expect(attachments.size).toBe(0);
    expect(released).toEqual(["forked-1"]);
  });

  it("leaves a claimed fork attachment alone", async () => {
    const attachments = new Map<string, SessionAttachment>();
    const released: string[] = [];
    const port = attachOnFork(forkingTrees("forked-1"), releasingPort(released), attachments);

    await port.fork("s1", "e1");
    attachments.delete("forked-1");
    await flush();

    expect(released).toEqual([]);
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
    const port = attachOnFork(trees, undefined, new Map());
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

describe("bindSessionLifecycle", () => {
  it("persists a turn in flight at close but skips the agent swap", async () => {
    const appended: Message[] = [];
    const attachment: SessionAttachment = {
      id: "s1",
      history: [],
      replay: () => {},
      append: async (message) => {
        appended.push(message);
      },
    };
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const next = new Agent({ provider: new MockProvider([]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    bindSessionLifecycle({
      pane,
      attachment,
      afterTurn: async () => [textMessage("user", "joined")],
      rebuild: () => next,
    });
    pane.submitPrompt("go");
    pane.dispose();
    await pane.settled();
    expect(appended.length).toBeGreaterThan(0);
    expect(pane.currentAgent()).toBe(agent);
  });
});
