import { Box, Text } from "@opentui/core";
import type { AppCore } from "../app-core.ts";
import { type GlyphSupport, resolveMark } from "../capability.ts";
import { lifecycleChrome, rampColor, rampPositions } from "../chroma.ts";
import type { Flavor } from "../flavor.ts";
import { fullRect, type Rect, type Screen } from "../geometry.ts";
import { pinMark } from "../marks.ts";
import type { ChromeWeight, LifecycleState, PaneView } from "../pane.ts";
import { hasHeaderRow, isSeamed, paneContentHeight, paneContentWidth } from "../pane-chrome.ts";
import { drawnRect } from "../pane-geometry.ts";
import type { Theme } from "../theme.ts";
import {
  anchorOutline,
  fieldOf,
  framedByOutline,
  onOutline,
  type SeamCell,
  type SeamField,
  type StrokeWeight,
  seamCells,
  seamsView,
} from "./seams.ts";
import { type StatusBarInputs, statusBar } from "./status-bar.ts";

export const frameChrome = { statusRows: 1 } as const;
export const pointerPlaneId = "pointer-plane";
export const idleMainId = "idle-main";
const pointerPlaneZIndex = 1000;

export type FocusOutline = "frame" | "grid";

export interface FrameInputs extends StatusBarInputs {
  screen: Screen;
  chrome: ChromeWeight;
  gap: number;
  focusOutline?: FocusOutline;
  instruments: Flavor["instruments"];
  glyphs: GlyphSupport;
  arcOf(paneId: string): string | undefined;
}

export function frameInset(chrome: ChromeWeight): number {
  return isSeamed(chrome) ? 1 : 0;
}

export function screenWithin(
  renderer: { width: number; height: number },
  chrome: ChromeWeight,
): Screen {
  const inset = frameInset(chrome);
  return {
    width: Math.max(0, renderer.width - 2 * inset),
    height: Math.max(0, renderer.height - 2 * inset - frameChrome.statusRows),
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
  const seamed = isSeamed(inputs.chrome);
  const inset = frameInset(inputs.chrome);
  const layoutField = fullRect(screen);
  const drawn = (rect: Rect): Rect => shifted(drawnRect(rect, layoutField, inputs), inset);
  const hueOf = (id: string): string => rampColor(theme.ramp, sweep.get(id) ?? 0);
  return Box(
    { width: screen.width + 2 * inset, height: screen.height + 2 * inset },
    ...[...rects].map(([id, rect]) =>
      placedBox(drawn(rect), paneViewFor(core, inputs, id, drawn(rect), id === focused, hueOf(id))),
    ),
    ...(idleMain === undefined
      ? []
      : [placedBox(drawn(idleMain), idleMainView(theme, hasHeaderRow(inputs.chrome)))]),
    ...(seamed
      ? [seamsLayer(core, inputs, rects, idleMain, focused, hueOf, inset, core.leaderArmed)]
      : []),
    ...(dropPreview === undefined ? [] : [dropPreviewBox(shifted(dropPreview, inset), theme)]),
  );
}

function seamsLayer(
  core: AppCore,
  inputs: FrameInputs,
  rects: ReadonlyMap<string, Rect>,
  idleMain: Rect | undefined,
  focused: string | undefined,
  hueOf: (id: string) => string,
  inset: number,
  navigating: boolean,
) {
  const { theme, screen } = inputs;
  const framed = new Map([...rects].map(([id, rect]) => [id, shifted(rect, inset)]));
  if (idleMain !== undefined) framed.set(idleMainId, shifted(idleMain, inset));
  const viewport = {
    width: screen.width + 2 * inset,
    height: screen.height + 2 * inset,
  };
  const field: SeamField = fieldOf(viewport, inset);
  const anchored = focused === undefined ? undefined : framed.get(focused);
  const outline = anchored === undefined ? undefined : anchorOutline(anchored, field.field);
  const outlineOf = (id: string, isFocused: boolean): string =>
    lifecycleChrome(lifecycleOf(core, id), isFocused, hueOf(id), theme).borderColor;
  const ink = (cell: SeamCell): string => {
    if (navigating && cell.ring) return theme.accent;
    if (focused !== undefined && outline !== undefined && onOutline(cell, outline)) {
      return outlineOf(focused, true);
    }
    if (cell.ring) return theme.border;
    return cell.owner === undefined || !rects.has(cell.owner)
      ? theme.border
      : outlineOf(cell.owner, false);
  };
  const stroke = (cell: SeamCell): StrokeWeight => (navigating && cell.ring ? "heavy" : "light");
  const cells = seamCells(framed, field);
  const framedCells =
    outline === undefined || inputs.focusOutline === "grid"
      ? cells
      : framedByOutline(cells, outline, (cell) => !(navigating && cell.ring));
  return seamsView(framedCells, ink, inputs.glyphs, stroke);
}

function lifecycleOf(core: AppCore, id: string): LifecycleState {
  return core.panes.get(id)?.lifecycle?.() ?? "idle";
}

function shifted(rect: Rect, inset: number): Rect {
  return { ...rect, x: rect.x + inset, y: rect.y + inset };
}

function paneViewFor(
  core: AppCore,
  inputs: FrameInputs,
  id: string,
  rect: Rect,
  focused: boolean,
  hue: string,
): PaneView {
  const { theme, chrome } = inputs;
  if (paneContentWidth({ ...rect, chrome }) < 1 || paneContentHeight({ ...rect, chrome }) < 1) {
    return overflowedView(theme);
  }
  const view = core.panes.get(id)?.view({
    theme,
    focused,
    width: rect.width,
    height: rect.height,
    chrome: inputs.chrome,
    costs: core.costsShown,
    hue,
    glyphs: inputs.glyphs,
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

function idleMainView(theme: Theme, bare: boolean) {
  return Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      ...(!bare && { border: true, borderStyle: "rounded", borderColor: theme.border }),
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
