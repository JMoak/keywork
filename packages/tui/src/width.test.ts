import { describe, expect, it } from "vitest";
import { clip, clipSpans, padEnd, segments, take, width, wrap } from "./width.ts";

describe("display width", () => {
  it("counts plain ascii one cell per character", () => {
    expect(width("keywork")).toBe(7);
    expect(width("")).toBe(0);
  });

  it("counts CJK two cells per character", () => {
    expect(width("我们在这")).toBe(8);
    expect(width("ｆｕｌｌ")).toBe(8);
  });

  it("folds combining marks into the base character", () => {
    expect(width("é")).toBe(1);
    expect(segments("é")).toEqual([{ text: "é", width: 1 }]);
  });

  it("treats an emoji with a variation selector as one wide segment", () => {
    expect(width("⚠️")).toBe(2);
    expect(segments("⚠️")).toEqual([{ text: "⚠️", width: 2 }]);
    expect(width("⚠")).toBe(1);
  });

  it("keeps ZWJ sequences, skin tones, keycaps, and flags whole", () => {
    expect(segments("👨‍👩‍👧")).toEqual([{ text: "👨‍👩‍👧", width: 2 }]);
    expect(width("👍🏽")).toBe(2);
    expect(width("1️⃣")).toBe(2);
    expect(segments("🇺🇸🇯🇵").map((segment) => segment.width)).toEqual([2, 2]);
  });

  it("gives control and zero-width characters no cells", () => {
    expect(width("a​b")).toBe(2);
  });
});

describe("clip", () => {
  it("returns text that already fits untouched", () => {
    expect(clip("abc", 3)).toBe("abc");
  });

  it("ends a clipped string with an ellipsis inside the budget, in cells", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("我们在这", 5)).toBe("我们…");
    expect(clip("我们在这", 4)).toBe("我…");
    expect(width(clip("ééé", 2))).toBe(2);
  });

  it("never splits a surrogate pair", () => {
    expect(clip("a😀b", 2)).toBe("a…");
    expect(clip("😀😀", 3)).toBe("😀…");
  });

  it("degrades to a lone ellipsis, then nothing", () => {
    expect(clip("abc", 1)).toBe("…");
    expect(clip("abc", 0)).toBe("");
  });
});

describe("take and padEnd", () => {
  it("takes the longest prefix that fits the cells", () => {
    expect(take("我们在这", 5)).toBe("我们");
    expect(take("abc", 0)).toBe("");
  });

  it("pads to a cell count, measuring wide characters honestly", () => {
    expect(padEnd("我", 4)).toBe("我  ");
    expect(padEnd("abc", 2)).toBe("abc");
    expect(padEnd("a", 3, ".")).toBe("a..");
  });
});

describe("wrap", () => {
  it("hard-wraps by cells, keeping wide glyphs and clusters whole", () => {
    expect(wrap("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrap("我们在这里", 4)).toEqual(["我们", "在这", "里"]);
    expect(wrap("a我b", 2)).toEqual(["a", "我", "b"]);
    expect(wrap("👨‍👩‍👧x", 2)).toEqual(["👨‍👩‍👧", "x"]);
  });

  it("keeps empty lines and unwrappable widths as one piece", () => {
    expect(wrap("", 5)).toEqual([""]);
    expect(wrap("abc", 0)).toEqual(["abc"]);
    expect(wrap("我", 1)).toEqual(["我"]);
  });
});

describe("clipSpans", () => {
  const spans = [
    { text: "hello ", tone: "a" },
    { text: "我们", tone: "b" },
    { text: " tail", tone: "c" },
  ];

  it("returns copies when everything fits", () => {
    const clipped = clipSpans(spans, 20);
    expect(clipped).toEqual(spans);
    expect(clipped[0]).not.toBe(spans[0]);
  });

  it("truncates silently on a cell budget without splitting wide glyphs", () => {
    expect(clipSpans(spans, 9)).toEqual([
      { text: "hello ", tone: "a" },
      { text: "我", tone: "b" },
    ]);
    expect(clipSpans(spans, 6)).toEqual([{ text: "hello ", tone: "a" }]);
  });

  it("reserves room for an ellipsis span when one is given", () => {
    const mark = { text: "…", tone: "meta" };
    expect(clipSpans(spans, 9, mark)).toEqual([
      { text: "hello ", tone: "a" },
      { text: "我", tone: "b" },
      mark,
    ]);
    expect(clipSpans(spans, 1, mark)).toEqual([mark]);
    expect(clipSpans(spans, 0, mark)).toEqual([]);
  });
});
