import { Box, Text } from "@opentui/core";
import type { AppCore } from "../app-core.ts";
import { type GlyphSupport, resolveMark } from "../capability.ts";
import { paneBorder, rampPositions } from "../chroma.ts";
import type { Flavor } from "../flavor.ts";
import type { Rect, Screen } from "../geometry.ts";
import { minPaneSize } from "../layout.ts";
import { pinMark } from "../marks.ts";
import type { PaneView } from "../pane.ts";
import type { Theme } from "../theme.ts";
import { type StatusBarInputs, statusBar } from "./status-bar.ts";

export const frameChrome = { statusRows: 1 } as const;
export const pointerPlaneId = "pointer-plane";
const pointerPlaneZIndex = 1000;

export interface FrameInputs extends StatusBarInputs {
  screen: Screen;
  instruments: Flavor["instruments"];
  glyphs: GlyphSupport;
  arcOf(paneId: string): string | undefined;
}

export function screenWithin(renderer: { width: number; height: number }): Screen {
  return {
    width: renderer.width,
    height: Math.max(0, renderer.height - frameChrome.statusRows),
  };
}

// OpenTUI dispatches mouse events through a hit grid of renderable ids; ids of
// renderables destroyed by a frame rebuild resolve to nothing and the event is
// dropped before reaching root. This persistent transparent plane renders above
// every frame, so hits always resolve to a live renderable that bubbles to root.
export function pointerPlane() {
  return Box({
    id: pointerPlaneId,
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: pointerPlaneZIndex,
  });
}

interface DiscardableFrame {
  getChildren(): ReadonlyArray<{ id?: string; destroyRecursively(): void }>;
}

// OpenTUI frees native text buffers only in destroy; remove() merely detaches,
// leaking Zig-side allocations until createTextBuffer fails and the app dies.
export function discardFrame(root: DiscardableFrame): void {
  for (const child of [...root.getChildren()]) {
    if (child.id !== pointerPlaneId) child.destroyRecursively();
  }
}

export function appFrame(core: AppCore, inputs: FrameInputs) {
  const { theme } = inputs;
  return Box(
    {
      flexDirection: "column",
      flexGrow: 1,
      width: "100%",
      height: "100%",
      backgroundColor: theme.background,
    },
    body(core, inputs),
    statusBar(core, inputs),
  );
}

function body(core: AppCore, inputs: FrameInputs) {
  const { theme, screen } = inputs;
  const rects = core.layout.rects(screen);
  const focused = core.layout.focused();
  if (rects.size === 0) {
    return Box(
      { width: screen.width, height: screen.height, flexDirection: "row" },
      emptyView(theme),
    );
  }
  const idleMain = core.layout.emptyMainRect(screen);
  const dropPreview = core.dragPreview();
  const sweep = rampPositions([...core.panes.keys()], (id) => {
    const arc = inputs.arcOf(id);
    return arc === undefined ? undefined : inputs.arcOrdinal(arc);
  });
  return Box(
    { width: screen.width, height: screen.height },
    ...[...rects].map(([id, rect]) =>
      placedBox(rect, paneViewFor(core, inputs, id, rect, id === focused, sweep.get(id) ?? 0)),
    ),
    ...(idleMain === undefined ? [] : [placedBox(idleMain, idleMainView(theme))]),
    ...(dropPreview === undefined ? [] : [dropPreviewBox(dropPreview, theme)]),
  );
}

function paneViewFor(
  core: AppCore,
  inputs: FrameInputs,
  id: string,
  rect: Rect,
  focused: boolean,
  rampPosition: number,
): PaneView {
  const { theme } = inputs;
  if (rect.width < minPaneSize.width || rect.height < minPaneSize.height) {
    return overflowedView(theme);
  }
  const view = core.panes.get(id)?.view({
    theme,
    focused,
    width: rect.width,
    height: rect.height,
    borderColor: paneBorder(theme, rampPosition, focused),
    instruments: inputs.instruments,
    ...(core.layout.pinned(id) && { pinMark: resolveMark(pinMark, inputs.glyphs) }),
  });
  return view ?? emptyView(theme);
}

function placedBox(rect: Rect, view: PaneView) {
  return Box(
    {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      flexDirection: "column",
      overflow: "hidden",
    },
    view,
  );
}

function dropPreviewBox(rect: Rect, theme: Theme) {
  return Box({
    position: "absolute",
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: 5,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.accent,
    overflow: "hidden",
  });
}

function idleMainView(theme: Theme) {
  return Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      overflow: "hidden",
    },
    Text({ content: "· main ·", fg: theme.textDim }),
    Text({ content: "ctrl+k s starts a session here", fg: theme.textDim }),
    Text({ content: "ctrl+k shift+l/h pushes a docked pane in", fg: theme.textDim }),
  );
}

function overflowedView(theme: Theme) {
  return Box(
    {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.panel,
      overflow: "hidden",
    },
    Text({ content: "⋯", fg: theme.textDim }),
  );
}

function emptyView(theme: Theme) {
  return Box(
    { flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" },
    Text({ content: "no sessions open", fg: theme.textDim }),
    Text({
      content: "ctrl+k s starts one · ctrl+p go · > commands · ctrl+q quits",
      fg: theme.textDim,
    }),
  );
}
