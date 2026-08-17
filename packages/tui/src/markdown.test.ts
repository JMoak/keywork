import { describe, expect, it } from "vitest";
import { markdownRowText, renderMarkdown } from "./markdown.ts";

const texts = (source: string, prose = 60, bleed = 60) =>
  renderMarkdown(source, prose, bleed).map(markdownRowText);

describe("inline markdown", () => {
  it("renders bold without the literal asterisks", () => {
    const rows = renderMarkdown("a **bold** word", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["a bold word"]);
    expect(rows[0]?.spans).toContainEqual({ text: "bold", tone: "body", bold: true });
  });

  it("renders italic through both delimiters", () => {
    const rows = renderMarkdown("*one* and _two_", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["one and two"]);
    expect(rows[0]?.spans).toContainEqual({ text: "one", tone: "body", italic: true });
    expect(rows[0]?.spans).toContainEqual({ text: "two", tone: "body", italic: true });
  });

  it("keeps snake_case out of emphasis", () => {
    expect(texts("call kebab_title_case here")).toEqual(["call kebab_title_case here"]);
  });

  it("renders code spans on their own tone", () => {
    const rows = renderMarkdown("run `bun test` now", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["run bun test now"]);
    expect(rows[0]?.spans).toContainEqual({ text: "bun test", tone: "code" });
  });

  it("shows a link label with its dim destination", () => {
    const rows = renderMarkdown("see [the docs](https://keywork.dev)", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["see the docs (https://keywork.dev)"]);
    expect(rows[0]?.spans).toContainEqual({ text: "the docs", tone: "link" });
    expect(rows[0]?.spans).toContainEqual({ text: " (https://keywork.dev)", tone: "linkUrl" });
  });

  it("nests bold inside emphasis marks", () => {
    const rows = renderMarkdown("**`bun run check`** first", 60, 60);
    expect(rows[0]?.spans).toContainEqual({ text: "bun run check", tone: "code" });
  });

  it("leaves unmatched markers as calm plain text", () => {
    expect(texts("2 ** 3 and a * star")).toEqual(["2 ** 3 and a * star"]);
    expect(texts("**unclosed")).toEqual(["**unclosed"]);
    expect(texts("`unclosed code")).toEqual(["`unclosed code"]);
  });
});

describe("block markdown", () => {
  it("marks headings with a density mark per depth", () => {
    const rows = renderMarkdown("# One\n## Two\n### Three\n#### Four", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["█ One", "▓ Two", "▒ Three", "░ Four"]);
    expect(rows[0]?.spans?.[0]).toEqual({ text: "█ ", tone: "headingMark" });
    expect(rows[0]?.spans?.[1]).toEqual({ text: "One", tone: "heading", bold: true });
  });

  it("hangs wrapped list items under their own text", () => {
    expect(texts("- alpha beta gamma delta", 12, 12)).toEqual([
      "• alpha beta",
      "  gamma",
      "  delta",
    ]);
  });

  it("keeps ordered markers as typed and accents them", () => {
    const rows = renderMarkdown("2. second thing", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["2. second thing"]);
    expect(rows[0]?.spans?.[0]).toEqual({ text: "2. ", tone: "listMarker" });
  });

  it("draws rules to the prose measure", () => {
    const rows = renderMarkdown("---", 20, 60);
    expect(rows.map(markdownRowText)).toEqual(["─".repeat(20)]);
    expect(rows[0]?.spans?.[0]?.tone).toBe("rule");
  });

  it("word-wraps paragraphs within the measure", () => {
    const rows = texts("the quick brown fox jumps over the lazy dog", 12, 60);
    expect(rows).toEqual(["the quick", "brown fox", "jumps over", "the lazy dog"]);
  });

  it("hard-splits words wider than the measure", () => {
    expect(texts("abcdefghij", 4, 60)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps blank lines as breathing room", () => {
    expect(texts("one\n\ntwo")).toEqual(["one", "", "two"]);
  });
});

describe("fences", () => {
  it("puts fence rows on the panel with a rail and language tag", () => {
    const rows = renderMarkdown("```ts\nconst a = 1;\n```", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["▎ ts", "▎ const a = 1;"]);
    expect(rows.every((row) => row.panel)).toBe(true);
    expect(rows[0]?.spans?.[1]).toEqual({ text: "ts", tone: "fenceTag" });
    expect(rows[1]?.spans?.[1]).toEqual({ text: "const a = 1;", tone: "fence" });
  });

  it("runs fence content at bleed width, not the prose measure", () => {
    const wide = "x".repeat(50);
    const rows = renderMarkdown(`\`\`\`\n${wide}\n\`\`\``, 10, 60);
    expect(rows.map(markdownRowText)).toEqual(["▎ ", `▎ ${wide}`]);
  });

  it("never parses fence content as markdown", () => {
    const rows = renderMarkdown("```\n**not bold** `raw`\n```", 60, 60);
    expect(rows.map(markdownRowText)).toEqual(["▎ ", "▎ **not bold** `raw`"]);
  });

  it("keeps an unclosed fence rendering calmly mid-stream", () => {
    expect(texts("```ts\nconst part")).toEqual(["▎ ts", "▎ const part"]);
  });
});
