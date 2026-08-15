import { Agent, type Message, MockProvider, textMessage, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { bindSessionLifecycle, type SessionAttachment, startFreshSession } from "./app.ts";
import { ConversationPane } from "./conversation-pane.ts";

function attachmentOf(id: string): SessionAttachment {
  return { id, history: [], replay: () => {}, append: async () => {} };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  it("discards a session that lands after the pane was disposed", async () => {
    let wired = false;
    let notified = 0;
    let release: (attachment: SessionAttachment | undefined) => void = () => {};
    startFreshSession(
      {
        open: async () => undefined,
        create: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
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
      agent,
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
