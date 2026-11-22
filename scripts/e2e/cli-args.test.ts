import { describe, expect, it } from "vitest";
import {
  type CaptureArgs,
  defaultOut,
  defaultSize,
  liveModeRefusal,
  parseCaptureArgs,
} from "./cli-args.ts";

describe("parseCaptureArgs", () => {
  it("parses --cwd and --live for the live tier", () => {
    expect(parseCaptureArgs(["live-playground", "--cwd", "C:/target", "--live"])).toMatchObject({
      ok: true,
      args: { scenarios: ["live-playground"], cwd: "C:/target", live: true },
    });
  });
});

describe("liveModeRefusal", () => {
  const args = (overrides: Partial<CaptureArgs>): CaptureArgs => ({
    scenarios: [],
    exclude: [],
    out: defaultOut,
    size: defaultSize,
    list: false,
    updateGoldens: false,
    live: false,
    ...overrides,
  });

  it("refuses --cwd without the --live consent flag", () => {
    expect(liveModeRefusal(args({ cwd: "C:/target" }))).toContain("--live");
  });

  it("refuses --live without a target --cwd", () => {
    expect(liveModeRefusal(args({ live: true, scenarios: ["live-playground"] }))).toContain(
      "--cwd",
    );
  });

  it("refuses to expand --live to the full scenario pack", () => {
    expect(liveModeRefusal(args({ live: true, cwd: "C:/target" }))).toContain("explicitly");
  });

  it("allows a live run naming its scenarios, and any temp-root run", () => {
    expect(
      liveModeRefusal(args({ live: true, cwd: "C:/target", scenarios: ["live-playground"] })),
    ).toBeUndefined();
    expect(liveModeRefusal(args({}))).toBeUndefined();
    expect(liveModeRefusal(args({ scenarios: ["cold-start"] }))).toBeUndefined();
  });
});
