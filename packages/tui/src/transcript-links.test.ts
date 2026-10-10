import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fileLinker, type SpanLinker } from "./file-references.ts";
import type { TranscriptEntry } from "./transcript-feed.ts";
import { type TranscriptLine, TranscriptView } from "./transcript-view.ts";

const root = resolve("/work/repo");
const hrefOf = (path: string, line: number) =>
  `${pathToFileURL(resolve(root, path)).href}#L${line}`;

function framed(entries: TranscriptEntry[], link?: SpanLinker, width = 80): TranscriptLine[] {
  return new TranscriptView().frame(
    { entries, streamingProgress: () => undefined, ...(link !== undefined && { link }) },
    { width, rows: 60 },
    { scrollBack: 0 },
  ).lines;
}

const hrefsOf = (lines: readonly TranscriptLine[]) =>
  lines.flatMap((line) => [
    ...(line.spans ?? []).flatMap((span) => (span.href === undefined ? [] : [span.href])),
    ...(line.links ?? []).map((link) => link.href),
  ]);

const toolEntry = (detail: string[]): TranscriptEntry => ({
  kind: "tool",
  text: "",
  failed: false,
  run: {
    name: "grep",
    subject: "needle",
    args: '{"pattern":"needle"}',
    replay: false,
    startedAtMs: 0,
    folded: false,
    outcome: "done",
    durationMs: 1,
    detail,
  },
});

describe("file links in the transcript", () => {
  const entries = (): TranscriptEntry[] => [
    { kind: "user", text: "why does src/app.ts:12 throw?" },
    { kind: "assistant", text: "Because `src/app.ts:12` calls **lib/parse.ts:40** too early." },
    toolEntry(["src/app.ts:12:  parse(input)"]),
  ];

  it("links nothing unless the source carries a linker, so the default stays plain", () => {
    expect(hrefsOf(framed(entries()))).toEqual([]);
  });

  it("links prose, code spans, user prompts, and tool output without changing a visible cell", () => {
    const plain = framed(entries());
    const linked = framed(entries(), fileLinker(root));
    expect(linked.map((line) => line.text)).toEqual(plain.map((line) => line.text));
    expect(new Set(hrefsOf(linked))).toEqual(
      new Set([hrefOf("src/app.ts", 12), hrefOf("lib/parse.ts", 40)]),
    );
    const prompt = linked[0];
    expect(prompt?.links).toHaveLength(1);
    const linkedText = prompt?.links?.map((link) => prompt.text.slice(link.from, link.to));
    expect(linkedText).toEqual(["src/app.ts:12"]);
  });

  it("links each row's piece of a reference that wraps, never one span across two rows", () => {
    const path = "packages/engine/src/providers/messages-wire.ts:210";
    const lines = framed([{ kind: "assistant", text: `see ${path}` }], fileLinker(root), 24);
    const href = hrefOf("packages/engine/src/providers/messages-wire.ts", 210);
    const carrying = lines.filter((line) => line.spans?.some((span) => span.href === href));
    expect(carrying.length).toBeGreaterThan(1);
    const pieces = carrying.flatMap((line) =>
      (line.spans ?? []).filter((span) => span.href === href).map((span) => span.text),
    );
    expect(pieces.join("")).toBe(path);
  });
});
