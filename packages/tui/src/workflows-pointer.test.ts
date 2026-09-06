import { describe, expect, it } from "vitest";
import { FileModel } from "./file-model.ts";
import { paletteFrame, paletteRowLimit } from "./overlays/index.ts";
import { AppProbe } from "./probe.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import { dockedIds, paneIds, stubFilePane } from "./testing/workflow-probe.ts";
import { resolveTheme } from "./theme.ts";

describe("mouse", () => {
  const modelFilePane = () => {
    const models = new Map<string, FileModel>();
    const probe = new AppProbe({
      createFilePane: (id, path) => {
        const model = new FileModel(process.cwd(), path, () => {});
        models.set(id, model);
        return stubFilePane(id, path, (chord) => model.handleKey(chord, 10));
      },
    });
    return { probe, models };
  };

  it("focuses the pane under a click", () => {
    const probe = new AppProbe();
    probe.command("split");
    const rect = probe.rect("session-1");
    probe.click(rect.x + 1, rect.y + 1);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("wheel-scrolls the pane under the cursor without moving focus", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const session = probe.rect("session-1");
    probe.click(session.x + 1, session.y + 1);
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 3);
    expect(models.get("file-1")?.scrollTop).toBe(3);
    expect(probe.snapshot().focused).toBe("session-1");
    probe.scroll(file.x + 1, file.y + 1, "up", 5);
    expect(models.get("file-1")?.scrollTop).toBe(0);
  });

  it("clamps huge wheel deltas to a bounded scroll", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 10_000);
    expect(models.get("file-1")?.scrollTop).toBe(10);
  });

  it("moves the palette selection on hover, and arrows still win afterwards", () => {
    const probe = new AppProbe().keys("ctrl+shift+p");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.hover(frame.x + 2, frame.firstRowY + 2);
    expect(probe.core.paletteIndex).toBe(2);
    probe.keys("down");
    expect(probe.core.paletteIndex).toBe(3);
  });

  it("runs the clicked palette row", () => {
    const probe = new AppProbe().keys("ctrl+shift+p").type("split");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("split").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.click(frame.x + 2, frame.firstRowY);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("closes the palette on an outside click without running anything", () => {
    const probe = new AppProbe().keys("ctrl+shift+p").type("split");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("closes the help overlay on an outside click", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("ignores clicks and scrolls when no pane is under the cursor", () => {
    const probe = new AppProbe();
    probe.click(500, 500).scroll(500, 500, "down").hover(500, 500);
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("drags a pane by its title row onto a sibling, previewing the swap rect", () => {
    const probe = new AppProbe();
    probe.command("split");
    const first = probe.rect("session-1");
    const second = probe.rect("session-2");
    probe.core.handleMouse({ type: "down", x: first.x + 2, y: first.y, button: 0 });
    probe.core.handleMouse({ type: "drag", x: second.x + 5, y: second.y + 5, button: 0 });
    expect(probe.core.draggingPane()).toBe("session-1");
    expect(probe.core.dragPreview()).toEqual(second);
    probe.core.handleMouse({ type: "up", x: second.x + 5, y: second.y + 5, button: 0 });
    expect(probe.core.dragPreview()).toBeUndefined();
    expect(probe.rect("session-1")).toEqual(second);
    expect(probe.rect("session-2")).toEqual(first);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("drags a main pane into a dock at the previewed slot", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");
    probe.command("dock-left");
    const dock = probe.rect("session-3");
    const source = probe.rect("session-1");
    probe.core.handleMouse({ type: "down", x: source.x + 2, y: source.y, button: 0 });
    probe.core.handleMouse({ type: "drag", x: dock.x + 1, y: dock.y + dock.height - 1, button: 0 });
    expect(probe.core.dragPreview()).toMatchObject({ x: dock.x, width: dock.width });
    probe.core.handleMouse({ type: "up", x: dock.x + 1, y: dock.y + dock.height - 1, button: 0 });
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("a plain title-row click focuses without rearranging anything", () => {
    const probe = new AppProbe();
    probe.command("split");
    const first = probe.rect("session-1");
    probe.click(first.x + 2, first.y);
    expect(probe.snapshot().focused).toBe("session-1");
    expect(probe.rect("session-1")).toEqual(first);
  });

  it("dropping where there is no target leaves the layout unchanged", () => {
    const probe = new AppProbe();
    probe.command("split");
    const first = probe.rect("session-1");
    probe.drag({ x: first.x + 2, y: first.y }, { x: first.x + 10, y: first.y + 10 });
    expect(probe.rect("session-1")).toEqual(first);
    expect(probe.core.dragPreview()).toBeUndefined();
  });
});

describe("entity tray pointer", () => {
  const emptyTreePort: SessionTreePort = {
    load: async () => undefined,
    setLabel: async () => {},
    fork: async () => undefined,
    overview: async () => [],
  };

  function probeWithTree() {
    const trees = new Map<string, SessionTreePane>();
    const probe = new AppProbe({
      createSessionTreePane: (id, notify, intents, targetSession) => {
        const pane = new SessionTreePane(id, notify, intents, emptyTreePort, targetSession);
        trees.set(id, pane);
        return pane;
      },
    });
    probe.command("tree");
    const pane = trees.get("tree-1");
    if (pane === undefined) throw new Error("no tree pane");
    return { probe, pane };
  }

  function renderTree(probe: AppProbe, pane: SessionTreePane) {
    const rect = probe.rect("tree-1");
    pane.view({ theme: resolveTheme(), focused: true, width: rect.width, height: rect.height });
    return rect;
  }

  it("hovers, clicks, and dismisses the tray through the handleMouse spine", async () => {
    const { probe, pane } = probeWithTree();
    await probe.settled();
    probe.keys("/");
    expect(pane.tray.open).toBe(true);
    const rect = renderTree(probe, pane);
    const firstRow = rect.y + 3;
    probe.hover(rect.x + 2, firstRow + 2);
    expect(pane.tray.selected()).toBe(2);
    probe.click(rect.x + 2, firstRow + 2);
    expect(pane.tray.open).toBe(false);
    probe.keys("/");
    renderTree(probe, pane);
    probe.click(rect.x + 2, rect.y + 1);
    expect(pane.tray.open).toBe(false);
  });
});
