import { describe, expect, it } from "vitest";
import { type SessionAttachment, startFreshSession } from "./app.ts";

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
