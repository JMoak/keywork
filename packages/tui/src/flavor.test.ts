import { parseFlavor } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import {
  FlavorSwitch,
  keyworkNightFlavor,
  registerFlavorCommands,
  startupFlavors,
  themeOf,
} from "./flavor.ts";
import { AppProbe } from "./probe.ts";
import { keyworkNight } from "./theme.ts";

const firstLight = parseFlavor({
  name: "first-light",
  appearance: "light",
  tokens: {
    background: "#f2f2f7",
    panel: "#e6e6ef",
    panelLift: "#dcdce8",
    text: "#1a1b26",
    textMid: "#3f4468",
    textDim: "#5f6486",
    border: "#c0c4d8",
    borderFocus: "#5a35c8",
    accent: "#5a35c8",
    accentSoft: "#6f55c9",
    success: "#28691e",
    error: "#a4213f",
    ramp: ["#5a35c8", "#2f6bc4", "#1f8a99"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "regular",
  instruments: "calm",
});

describe("keyworkNightFlavor", () => {
  it("carries today's palette exactly", () => {
    expect(themeOf(keyworkNightFlavor)).toEqual(keyworkNight);
  });
});

describe("startupFlavors", () => {
  it("wears keywork-night untouched with no overrides", () => {
    const [worn] = startupFlavors();
    expect(worn).toEqual(keyworkNightFlavor);
  });

  it("folds token overrides into the worn flavor instead of a second mechanism", () => {
    const [worn] = startupFlavors({ accent: "#7dcfff", ramp: ["#7dcfff"] });
    expect(worn?.tokens.accent).toBe("#7dcfff");
    expect(worn?.tokens.ramp).toEqual(["#7dcfff"]);
    expect(worn?.tokens.text).toBe(keyworkNight.text);
  });

  it("leaves every token it was not handed equal to keywork-night's", () => {
    const [worn] = startupFlavors({ accentSoft: "#7dcfff" });
    const { accentSoft, ...rest } = worn?.tokens ?? keyworkNight;
    const { accentSoft: night, ...nightRest } = keyworkNight;
    expect(accentSoft).toBe("#7dcfff");
    expect(accentSoft).not.toBe(night);
    expect(rest).toEqual(nightRest);
    expect({ ...worn, tokens: undefined }).toEqual({ ...keyworkNightFlavor, tokens: undefined });
  });

  it("refuses overrides that sink below the contrast floor, helpfully", () => {
    expect(() => startupFlavors({ text: "#20222e" })).toThrow(/text on background/);
  });

  it("wears the named closet flavor first and keeps the rest hanging", () => {
    const [worn, ...rest] = startupFlavors({}, [firstLight], "first-light");
    expect(worn).toEqual(firstLight);
    expect(rest).toEqual([keyworkNightFlavor]);
  });

  it("lays overrides over the worn flavor, whichever it is", () => {
    const [worn] = startupFlavors(
      { accent: "#1f8a99", ramp: ["#1f8a99"] },
      [firstLight],
      "first-light",
    );
    expect(worn?.tokens.accent).toBe("#1f8a99");
    expect(worn?.tokens.background).toBe(firstLight.tokens.background);
  });

  it("falls back to keywork-night when the named flavor is not in the closet", () => {
    const [worn, ...rest] = startupFlavors({}, [firstLight], "neo-tokyo");
    expect(worn).toEqual(keyworkNightFlavor);
    expect(rest).toEqual([firstLight]);
  });
});

describe("flavor hot-swap", () => {
  it("swaps the live theme through the palette command and repaints", () => {
    const probe = new AppProbe();
    const flavors = new FlavorSwitch([keyworkNightFlavor, firstLight]);
    let repaints = 0;
    registerFlavorCommands(probe.core.registry, flavors, {
      repaint: () => {
        repaints += 1;
      },
      notice: (text) => probe.core.postNotice(text),
    });
    expect(flavors.theme.background).toBe(keyworkNight.background);
    expect(probe.command("flavor-first-light")).toBe(true);
    expect(flavors.active.name).toBe("first-light");
    expect(flavors.theme.background).toBe("#f2f2f7");
    expect(repaints).toBe(1);
    expect(probe.snapshot().notice).toBe("flavor now first-light");
  });

  it("stays put when asked for the flavor already worn", () => {
    const probe = new AppProbe();
    const flavors = new FlavorSwitch([keyworkNightFlavor, firstLight]);
    let repaints = 0;
    registerFlavorCommands(probe.core.registry, flavors, {
      repaint: () => {
        repaints += 1;
      },
      notice: (text) => probe.core.postNotice(text),
    });
    expect(probe.command("flavor-keywork-night")).toBe(true);
    expect(flavors.active.name).toBe("keywork-night");
    expect(repaints).toBe(0);
    expect(probe.snapshot().notice).toBe("already wearing keywork-night");
  });

  it("refuses to wear a flavor it never validated", () => {
    const flavors = new FlavorSwitch([keyworkNightFlavor]);
    expect(() => flavors.swap("neo-tokyo")).toThrow(/no flavor named "neo-tokyo"/);
  });
});
