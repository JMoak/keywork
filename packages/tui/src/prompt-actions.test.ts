import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import type { EditorResult } from "./external-editor.ts";
import type { ClipboardRead, PastedImage } from "./image-paste.ts";
import { AppProbe, type AppProbeOptions } from "./probe.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const image: PastedImage = {
  part: { type: "image", mediaType: "image/png", data: "AAAA" },
  bytes: 4,
  format: "png",
};

function probeWith(options: AppProbeOptions = {}): { probe: AppProbe; pane: ConversationPane } {
  const probe = new AppProbe(options);
  const pane = probe.core.panes.get("session-1");
  if (!(pane instanceof ConversationPane)) throw new Error("the first pane is a conversation");
  return { probe, pane };
}

async function flushed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the external editor action", () => {
  it("ctrl+g hands the draft out and loads the edit back", async () => {
    const drafts: string[] = [];
    const { probe, pane } = probeWith({
      externalEditor: async (draft) => {
        drafts.push(draft);
        return { kind: "edited", text: `${draft} edited outside` };
      },
    });
    probe.type("hi").keys("ctrl+g");
    await flushed();
    expect(drafts).toEqual(["hi"]);
    expect(pane.model.input).toBe("hi edited outside");
  });

  it("/editor is the same door and a failure leaves the draft alone with a notice", async () => {
    const result: EditorResult = { kind: "failed", reason: "vim exited with code 1" };
    const { probe, pane } = probeWith({ externalEditor: async () => result });
    probe.type("keep");
    probe.command("editor");
    await flushed();
    expect(pane.model.input).toBe("keep");
    expect(probe.snapshot().notice).toBe(
      "editor · vim exited with code 1 · your draft is untouched",
    );
  });

  it("runs one edit at a time and says so without a port", async () => {
    let edits = 0;
    const { probe } = probeWith({
      externalEditor: () =>
        new Promise((resolve) => {
          edits += 1;
          setTimeout(() => resolve({ kind: "unchanged" }), 5);
        }),
    });
    probe.keys("ctrl+g", "ctrl+g");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(edits).toBe(1);
    const bare = probeWith();
    bare.probe.keys("ctrl+g");
    expect(bare.probe.snapshot().notice).toBe("no external editor here");
  });

  it("needs a conversation pane in focus", () => {
    const { probe } = probeWith({
      externalEditor: async () => ({ kind: "unchanged" }),
      createMemoryPane: (id) => ({ id, title: () => id, view: () => ({}) as never }),
    });
    probe.command("memory");
    probe.keys("ctrl+g");
    expect(probe.snapshot().notice).toBe(
      "the external editor needs a conversation prompt · focus one first",
    );
  });
});

describe("the image actions", () => {
  it("/image <path> attaches a file and complains about anything else", () => {
    const { probe, pane } = probeWith({
      readImage: (path) => (path === "/a.png" ? png : undefined),
    });
    probe.command("image /a.png");
    expect(pane.model.input).toBe("[image #1, png 4 B] ");
    probe.command("image /b.png");
    expect(probe.snapshot().notice).toBe("no image at /b.png · png, jpg, gif or webp up to 5 MB");
  });

  it("ctrl+v and a bare /image read the host clipboard", async () => {
    const reads: ClipboardRead[] = [
      { kind: "image", image },
      { kind: "text", text: "pasted words" },
      { kind: "empty" },
      { kind: "unsupported" },
    ];
    const { probe, pane } = probeWith({
      clipboard: { read: async () => reads.shift() ?? { kind: "empty" } },
    });
    probe.keys("ctrl+v");
    await flushed();
    expect(pane.model.input).toBe("[image #1, png 4 B] ");
    probe.command("image");
    await flushed();
    expect(pane.model.input).toBe("[image #1, png 4 B] pasted words");
    probe.keys("ctrl+v");
    await flushed();
    expect(probe.snapshot().notice).toBe("the clipboard holds no image or text");
    probe.keys("ctrl+v");
    await flushed();
    expect(probe.snapshot().notice).toContain("out of reach here");
  });

  it("points at /image <path> when there is no host clipboard", () => {
    const { probe } = probeWith();
    probe.keys("ctrl+v");
    expect(probe.snapshot().notice).toBe(
      "no host clipboard here · /image <path> attaches a file instead",
    );
  });

  it("pastes with image facts reach the conversation pane", () => {
    const { probe, pane } = probeWith();
    probe.core.handlePaste("", { mimeType: "image/png", kind: "binary", bytes: png });
    expect(pane.model.input).toBe("[image #1, png 4 B] ");
  });
});
