import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fileHref,
  fileLinker,
  fileReferences,
  linkSpans,
  sliceSpans,
  unlinked,
  wrapLinked,
} from "./file-references.ts";

const root = resolve("/work/repo");
const hrefOf = (path: string, line: number) =>
  `${pathToFileURL(resolve(root, path)).href}#L${line}`;

describe("fileReferences", () => {
  const found = (text: string) =>
    fileReferences(text).map((reference) => ({
      text: text.slice(reference.from, reference.to),
      path: reference.path,
      line: reference.line,
    }));

  it("finds path:line and path:line:col in prose", () => {
    expect(found("see src/app.ts:42 and lib/x.test.ts:7:3 for both")).toEqual([
      { text: "src/app.ts:42", path: "src/app.ts", line: 42 },
      { text: "lib/x.test.ts:7:3", path: "lib/x.test.ts", line: 7 },
    ]);
  });

  it("reads grep-shaped output, relative, absolute, and home paths", () => {
    expect(found("packages/tui/src/osc.ts:12:export function")).toEqual([
      { text: "packages/tui/src/osc.ts:12", path: "packages/tui/src/osc.ts", line: 12 },
    ]);
    expect(found("(./a.md:1) ../b/c.rs:20, /etc/d.conf:3 ~/e.py:4")).toEqual([
      { text: "./a.md:1", path: "./a.md", line: 1 },
      { text: "../b/c.rs:20", path: "../b/c.rs", line: 20 },
      { text: "/etc/d.conf:3", path: "/etc/d.conf", line: 3 },
      { text: "~/e.py:4", path: "~/e.py", line: 4 },
    ]);
    expect(found("at C:\\src\\keywork\\a.ts:9")).toEqual([
      { text: "C:\\src\\keywork\\a.ts:9", path: "C:\\src\\keywork\\a.ts", line: 9 },
    ]);
  });

  it("leaves urls, times, versions, and bare words alone", () => {
    expect(found("https://example.dev/src/a.ts:12")).toEqual([]);
    expect(found("at 12:30 we shipped v1.2.3:4 to localhost:3000")).toEqual([]);
    expect(found("line:12 and Makefile:3 and a.ts: 4")).toEqual([]);
  });
});

describe("fileHref", () => {
  it("builds an absolute file url with a line fragment", () => {
    expect(fileHref(root, { path: "src/app.ts", line: 42 })).toBe(hrefOf("src/app.ts", 42));
    expect(fileHref(root, { path: "src/app.ts", line: 42 })).toMatch(/^file:\/\/.*#L42$/);
  });
});

describe("linkSpans", () => {
  it("splits spans at reference bounds and keeps their other fields", () => {
    const spans = [
      { text: "open src/", tone: "body" },
      { text: "a.ts:3 now", tone: "code" },
    ];
    expect(fileLinker(root)(spans)).toEqual([
      { text: "open ", tone: "body" },
      { text: "src/", tone: "body", href: hrefOf("src/a.ts", 3) },
      { text: "a.ts:3", tone: "code", href: hrefOf("src/a.ts", 3) },
      { text: " now", tone: "code" },
    ]);
  });

  it("returns the spans untouched when nothing links or links are off", () => {
    const spans = [{ text: "nothing here" }];
    expect(linkSpans(spans, [])).toEqual(spans);
    expect(unlinked([{ text: "src/a.ts:3" }])).toEqual([{ text: "src/a.ts:3" }]);
  });
});

describe("wrapLinked", () => {
  it("keeps the visible rows identical to plain wrapping", () => {
    const text = "look at packages/tui/src/conversation-pane.ts:120 then stop";
    const rows = wrapLinked(text, 20, fileLinker(root));
    const plain = wrapLinked(text, 20, unlinked);
    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(
      plain.map((row) => row.map((span) => span.text).join("")),
    );
  });

  it("links every wrapped piece of a reference that breaks across rows, closing per row", () => {
    const path = "packages/tui/src/conversation-pane.ts:120";
    const rows = wrapLinked(`see ${path} ok`, 16, fileLinker(root));
    const href = hrefOf("packages/tui/src/conversation-pane.ts", 120);
    const linkedPieces = rows.flatMap((row) => row.filter((span) => span.href === href));
    expect(linkedPieces.length).toBeGreaterThan(1);
    expect(linkedPieces.map((span) => span.text).join("")).toBe(path);
    for (const row of rows) {
      const hrefs = row.map((span) => span.href);
      expect(hrefs.filter((value) => value !== undefined).length).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a blank line blank", () => {
    expect(wrapLinked("", 10, fileLinker(root))).toEqual([[]]);
  });
});

describe("sliceSpans", () => {
  it("cuts a span run to a character range", () => {
    const spans = [{ text: "abc" }, { text: "def", href: "x" }];
    expect(sliceSpans(spans, 2, 5)).toEqual([{ text: "c" }, { text: "de", href: "x" }]);
  });
});
