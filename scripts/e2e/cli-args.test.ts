import { describe, expect, it } from "vitest";
import {
  type CaptureArgs,
  defaultOut,
  defaultSize,
  liveModeRefusal,
  parseCaptureArgs,
} from "./cli-args.ts";

describe("parseCaptureArgs", () => {
  it("defaults to every scenario at the standard size, comparing goldens", () => {
    expect(parseCaptureArgs([])).toEqual({
      ok: true,
      args: {
        scenarios: [],
        out: defaultOut,
        size: defaultSize,
        list: false,
        updateGoldens: false,
        live: false,
      },
    });
  });

  it("collects positional scenario names in order", () => {
    const parsed = parseCaptureArgs(["first-conversation", "tiling-tour"]);
    expect(parsed).toMatchObject({
      ok: true,
      args: { scenarios: ["first-conversation", "tiling-tour"] },
    });
  });

  it("parses --size as cols x rows", () => {
    expect(parseCaptureArgs(["--size", "80x24"])).toMatchObject({
      ok: true,
      args: { size: { width: 80, height: 24 } },
    });
  });

  it("rejects malformed and absurdly small sizes", () => {
    expect(parseCaptureArgs(["--size", "80by24"]).ok).toBe(false);
    expect(parseCaptureArgs(["--size", "5x3"]).ok).toBe(false);
    expect(parseCaptureArgs(["--size"]).ok).toBe(false);
  });

  it("accepts --out and --list alongside scenario names", () => {
    expect(parseCaptureArgs(["s6", "--out", "tmp/frames", "--list"])).toEqual({
      ok: true,
      args: {
        scenarios: ["s6"],
        out: "tmp/frames",
        size: defaultSize,
        list: true,
        updateGoldens: false,
        live: false,
      },
    });
  });

  it("switches golden captures into write mode with --update-goldens", () => {
    expect(parseCaptureArgs(["--update-goldens"])).toMatchObject({
      ok: true,
      args: { updateGoldens: true },
    });
  });

  it("parses --cwd and --live for the live tier", () => {
    expect(parseCaptureArgs(["live-playground", "--cwd", "C:/target", "--live"])).toMatchObject({
      ok: true,
      args: { scenarios: ["live-playground"], cwd: "C:/target", live: true },
    });
  });

  it("requires a value for --cwd", () => {
    expect(parseCaptureArgs(["--cwd"])).toEqual({ ok: false, error: "--cwd requires a value" });
  });

  it("rejects unknown flags", () => {
    const parsed = parseCaptureArgs(["--frames"]);
    expect(parsed).toEqual({ ok: false, error: "unknown flag: --frames" });
  });
});

describe("liveModeRefusal", () => {
  const args = (overrides: Partial<CaptureArgs>): CaptureArgs => ({
    scenarios: [],
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
