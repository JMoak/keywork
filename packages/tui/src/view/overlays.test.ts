import { describe, expect, it } from "vitest";
import { AppCore } from "../app-core.ts";
import { keyworkNight } from "../theme.ts";
import { overlayView, scrimInk } from "./overlays.ts";

function paletteCore(): AppCore {
  const core = new AppCore({
    screen: () => ({ width: 100, height: 30 }),
    createPane: () => undefined,
    onExit: () => {},
  });
  core.openPalette();
  return core;
}

const inputs = {
  theme: keyworkNight,
  chrome: "seams" as const,
  arcOrdinal: () => undefined,
};

interface RenderedBox {
  props?: { backgroundColor?: unknown; zIndex?: number };
  children?: RenderedBox[];
}

describe("the overlay scrim", () => {
  it("stays out of the render unless asked for", () => {
    const view = overlayView(paletteCore(), inputs) as RenderedBox;
    expect(view).toBeDefined();
    expect(view.props?.zIndex).toBe(20);
  });

  it("slides a translucent ground behind the panel when enabled", () => {
    const view = overlayView(paletteCore(), { ...inputs, scrim: true }) as RenderedBox;
    expect(view.props?.zIndex).toBe(15);
    const [ground, panel] = view.children ?? [];
    expect(ground?.props?.backgroundColor).toBe(scrimInk(keyworkNight));
    expect(panel?.props?.zIndex).toBe(20);
  });

  it("derives the scrim from the theme ground with alpha", () => {
    expect(scrimInk(keyworkNight)).toBe(`${keyworkNight.background}99`);
  });

  it("renders nothing when no overlay is open, scrim or not", () => {
    const idle = new AppCore({
      screen: () => ({ width: 100, height: 30 }),
      createPane: () => undefined,
      onExit: () => {},
    });
    expect(overlayView(idle, { ...inputs, scrim: true })).toBeUndefined();
  });
});
