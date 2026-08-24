import { RGBA } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { slugChunks, slugInk, slugParts, slugWords } from "./slug.ts";
import { keyworkNight } from "./theme.ts";

describe("the slug display grammar", () => {
  it("splits a slug into lit words and dim separators", () => {
    expect(slugParts("auth-retry-fix")).toEqual([
      { text: "auth", role: "word" },
      { text: "-", role: "separator" },
      { text: "retry", role: "word" },
      { text: "-", role: "separator" },
      { text: "fix", role: "word" },
    ]);
  });

  it("marks the arc colon as its own role", () => {
    expect(slugParts("mcp-hardening:sleep-wake").map((part) => part.role)).toEqual([
      "word",
      "separator",
      "word",
      "colon",
      "word",
      "separator",
      "word",
    ]);
  });

  it("turns a slug into human words with no separators at all", () => {
    expect(slugWords("mcp-hardening:sleep-wake")).toBe("mcp hardening sleep wake");
    expect(slugWords("session-1")).toBe("session 1");
    expect(slugWords("solo")).toBe("solo");
  });

  it("reassembles to the stored slug, so identity is never lost", () => {
    for (const slug of ["a", "a-b", "arc:one-two", "x--y", ":lead", "trail-"]) {
      expect(
        slugParts(slug)
          .map((part) => part.text)
          .join(""),
      ).toBe(slug);
    }
  });

  it("inks words in the given color and separators dim, the colon soft accent", () => {
    const ink = slugInk(keyworkNight, keyworkNight.accentSoft);
    expect(ink).toEqual({
      word: keyworkNight.accentSoft,
      separator: keyworkNight.textDim,
      colon: keyworkNight.accentSoft,
    });
    const chunks = slugChunks("arc:a-b", ink);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["arc", ":", "a", "-", "b"]);
    const expectedInk = [ink.word, ink.colon, ink.word, ink.separator, ink.word];
    chunks.forEach((chunk, index) => {
      expect(RGBA.fromHex(expectedInk[index] as string).equals(chunk.fg)).toBe(true);
    });
  });
});
