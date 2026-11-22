import { describe, expect, it } from "vitest";
import { hexChannels, hexColor } from "./color.ts";

describe("hexColor", () => {
  it("rejects names, short forms, and bare hex with one vocabulary", () => {
    for (const candidate of ["purple", "#fff", "bb9af7", "#bb9af7ff"]) {
      const parsed = hexColor.safeParse(candidate);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("colors must be #rrggbb");
    }
  });
});

describe("hexChannels", () => {
  it("decodes red, green, and blue bytes", () => {
    expect(hexChannels("#010203")).toEqual([1, 2, 3]);
    expect(hexChannels("#FFFFFF")).toEqual([255, 255, 255]);
  });

  it("rejects malformed hex", () => {
    expect(() => hexChannels("#fff")).toThrow(/#rrggbb/);
  });
});
