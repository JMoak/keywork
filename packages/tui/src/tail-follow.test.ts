import { describe, expect, it } from "vitest";
import { elideMiddle, TailFollow, tailRowLimit } from "./tail-follow.ts";

describe("TailFollow", () => {
  it("shows the latest lines of output, bounded to the tail window", () => {
    const tail = new TailFollow();
    tail.push("one\ntwo\nthree\nfour\nfive\n");
    expect(tail.rows(80)).toEqual(["three", "four", "five"]);
  });

  it("includes a partial trailing line as it streams", () => {
    const tail = new TailFollow();
    tail.push("done: 1\ndone: 2\nworking on 3");
    expect(tail.rows(80)).toEqual(["done: 1", "done: 2", "working on 3"]);
  });

  it("renders nothing before any output arrives", () => {
    expect(new TailFollow().rows(80)).toEqual([]);
  });

  it("strips ANSI color, cursor, and OSC sequences plus control characters", () => {
    const tail = new TailFollow();
    tail.push("\x1b[31mred\x1b[0m \x1b]0;title\x07plain\x07\x00\x1b[2K");
    expect(tail.rows(80)).toEqual(["red plain"]);
  });

  it("treats carriage returns as progress-bar line rewrites", () => {
    const tail = new TailFollow();
    tail.push("10%\r20%\r100%");
    expect(tail.rows(80)).toEqual(["100%"]);
  });

  it("middle-elides absurdly long lines to the window width", () => {
    const tail = new TailFollow();
    tail.push(`start${"x".repeat(10_000)}end`);
    const rows = tail.rows(20);
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? "";
    expect(Array.from(row).length).toBeLessThanOrEqual(20);
    expect(row.startsWith("start")).toBe(true);
    expect(row).toContain("…");
  });

  it("keeps memory bounded under sustained floods of lines", () => {
    const tail = new TailFollow();
    for (let at = 0; at < 5_000; at += 1) tail.push(`line ${at}\n`);
    expect(tail.rows(80)).toEqual(["line 4997", "line 4998", "line 4999"]);
    expect(tail.rows(80).length).toBeLessThanOrEqual(tailRowLimit);
  });

  it("advances the density-ramp mark deterministically with output volume", () => {
    const tail = new TailFollow();
    expect(tail.mark()).toBe("░");
    tail.push("x".repeat(256));
    expect(tail.mark()).toBe("▒");
    tail.push("x".repeat(512));
    expect(tail.mark()).toBe("█");
    tail.push("x".repeat(256));
    expect(tail.mark()).toBe("░");
  });
});

describe("elideMiddle", () => {
  it("returns short lines unchanged", () => {
    expect(elideMiddle("short", 10)).toBe("short");
  });

  it("never splits surrogate pairs", () => {
    const elided = elideMiddle("😀".repeat(40), 9);
    expect(elided).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(Array.from(elided).length).toBeLessThanOrEqual(9);
  });

  it("collapses to a single ellipsis at width one", () => {
    expect(elideMiddle("abcdef", 1)).toBe("…");
  });
});
