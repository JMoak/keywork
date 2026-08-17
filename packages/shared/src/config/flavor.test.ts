import { describe, expect, it } from "vitest";
import { contrastFailures, type Flavor, parseFlavor } from "./flavor.ts";

const night: Flavor = {
  name: "night-fixture",
  appearance: "dark",
  tokens: {
    background: "#1a1b26",
    panel: "#1f2335",
    panelLift: "#24283b",
    text: "#c0caf5",
    textMid: "#828bb8",
    textDim: "#565f89",
    border: "#3b4261",
    borderFocus: "#bb9af7",
    accent: "#bb9af7",
    accentSoft: "#9d7cd8",
    success: "#9ece6a",
    error: "#f7768e",
    ramp: ["#bb9af7", "#7aa2f7", "#7dcfff"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "regular",
  instruments: "calm",
};

function withTokens(tokens: Partial<Flavor["tokens"]>): unknown {
  return { ...night, tokens: { ...night.tokens, ...tokens } };
}

describe("parseFlavor", () => {
  it("round-trips a readable flavor file through the schema", () => {
    const parsed = parseFlavor(JSON.parse(JSON.stringify(night)));
    expect(parsed).toEqual(night);
  });

  it("fails a flavor whose ink sinks into the ground, and says which pair", () => {
    expect(() => parseFlavor(withTokens({ textDim: "#1c1d28" }))).toThrow(
      /night-fixture.*textDim on background measures Lc [\d.]+, needs at least 15/s,
    );
  });

  it("fails a density level mapped onto too quiet a token", () => {
    const flavor = { ...night, density: { ...night.density, full: "textDim" } };
    expect(() => parseFlavor(flavor)).toThrow(/density full/);
  });

  it("lists every failing pair so one reload fixes them all", () => {
    const buried = parseFlavor.bind(undefined, withTokens({ text: "#3a3d52", textMid: "#2a2d42" }));
    expect(buried).toThrow(/text on background/);
    expect(buried).toThrow(/textMid on background/);
  });

  it("points into the schema when the shape is wrong", () => {
    const { accent, ...missingAccent } = night.tokens;
    expect(() => parseFlavor({ ...night, tokens: missingAccent })).toThrow(
      /does not fit the schema at tokens\.accent/,
    );
    expect(() => parseFlavor({ ...night, extra: true })).toThrow(/does not fit the schema/);
    expect(() => parseFlavor({ ...night, gap: 9 })).toThrow(/at gap/);
  });

  it("holds ramp stops to the same color rule as tokens", () => {
    expect(() => parseFlavor(withTokens({ ramp: ["purple"] }))).toThrow(/rrggbb/);
    expect(() => parseFlavor(withTokens({ ramp: [] }))).toThrow(/at tokens\.ramp/);
  });
});

describe("contrastFailures", () => {
  it("reads clean on the reference palette", () => {
    expect(contrastFailures(night)).toEqual([]);
  });
});
