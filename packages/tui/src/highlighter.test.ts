import { describe, expect, it } from "vitest";
import { highlightedLanguages, highlighterFor, type SyntaxSpan } from "./highlighter.ts";

const spansOf = (language: string, ...lines: string[]): SyntaxSpan[][] => {
  const highlighter = highlighterFor(language);
  return lines.map((line) => highlighter.line(line));
};

const classOf = (spans: SyntaxSpan[], text: string) =>
  spans.find((span) => span.text === text)?.syntax;

describe("the highlighter", () => {
  it("reassembles every line it tokenizes, byte for byte", () => {
    const corpus = [
      ["ts", 'const a: Map<string, number> = new Map(); // note "quoted"'],
      ["ts", `const t = \`tpl \${a + 1}\` + 0x1f + 1_000n;`],
      ["json", '{ "name": "keywork", "version": 1.2, "ok": true, "none": null }'],
      ["sh", `export FOO="\${BAR:-x}" # trailing comment; echo $? $#`],
      ["py", 'def f(x: int) -> str:  # doc\n    return f"{x!r}"'],
      ["go", 'func main() { fmt.Println("hi", 42, nil) }'],
      ["rs", 'fn main() { let v: Vec<u8> = vec![1u8, 2, 3]; println!("{:?}", v); }'],
      ["diff", "@@ -1,2 +1,2 @@"],
      ["md", "- item with `code` and **bold**"],
      ["nope", "anything at all"],
    ] as const;
    for (const [language, text] of corpus) {
      for (const line of text.split("\n")) {
        const spans = highlighterFor(language).line(line);
        expect(spans.map((span) => span.text).join("")).toBe(line);
      }
    }
  });

  it("leaves unknown languages calmly unstyled", () => {
    expect(spansOf("brainfuck", "+++[>+<-]")).toEqual([[{ text: "+++[>+<-]" }]]);
    expect(spansOf("", "plain")).toEqual([[{ text: "plain" }]]);
    expect(highlighterFor("ts").line("")).toEqual([]);
  });

  it("classifies typescript keywords, types, strings, numbers, and comments", () => {
    const [spans] = spansOf("ts", 'const page: PageGrammar = resolve("w", 42); // tiers');
    expect(spans).toBeDefined();
    if (spans === undefined) return;
    expect(classOf(spans, "const")).toBe("keyword");
    expect(classOf(spans, "PageGrammar")).toBe("type");
    expect(classOf(spans, '"w"')).toBe("string");
    expect(classOf(spans, "42")).toBe("constant");
    expect(classOf(spans, "// tiers")).toBe("comment");
    expect(classOf(spans, "resolve")).toBeUndefined();
  });

  it("carries block comments and template literals across lines", () => {
    const [first, second, third] = spansOf("ts", "a /* open", "still comment */ b", "`x");
    expect(first?.at(-1)).toEqual({ text: "/* open", syntax: "comment" });
    expect(second?.[0]).toEqual({ text: "still comment */", syntax: "comment" });
    expect(classOf(second ?? [], "b")).toBeUndefined();
    expect(third).toEqual([{ text: "`x", syntax: "string" }]);
  });

  it("keeps each highlighter's block state to itself", () => {
    const opened = highlighterFor("ts");
    opened.line("/* never closed");
    expect(highlighterFor("ts").line("const x")[0]?.syntax).toBe("keyword");
    expect(opened.line("const x")[0]?.syntax).toBe("comment");
  });

  it("treats an unterminated quote as a string to the end of the line", () => {
    const [spans] = spansOf("ts", 'say("hello');
    expect(spans?.at(-1)).toEqual({ text: '"hello', syntax: "string" });
  });

  it("distinguishes json keys from string values", () => {
    const [spans] = spansOf("json", '{"name": "keywork", "tags": ["a"]}');
    expect(classOf(spans ?? [], '"name"')).toBe("type");
    expect(classOf(spans ?? [], '"keywork"')).toBe("string");
    expect(classOf(spans ?? [], '"a"')).toBe("string");
  });

  it("reads shell variables and boundary-only comments", () => {
    const [spans] = spansOf("sh", `echo "$HOME" \${USER} a#b # done`);
    expect(classOf(spans ?? [], "echo")).toBe("keyword");
    expect(classOf(spans ?? [], `\${USER}`)).toBe("type");
    expect(classOf(spans ?? [], "a#b")).toBeUndefined();
    expect(classOf(spans ?? [], "# done")).toBe("comment");
  });

  it("handles python triple quotes across lines and its literal constants", () => {
    const [first, second, third] = spansOf("py", 'x = """doc', "more", '""" or None');
    expect(first?.at(-1)).toEqual({ text: '"""doc', syntax: "string" });
    expect(second).toEqual([{ text: "more", syntax: "string" }]);
    expect(third?.[0]).toEqual({ text: '"""', syntax: "string" });
    expect(classOf(third ?? [], "None")).toBe("constant");
  });

  it("knows go and rust builtins by name and capitalized types by shape", () => {
    const [goSpans] = spansOf("go", "var n int = len(Thing{})");
    expect(classOf(goSpans ?? [], "int")).toBe("type");
    expect(classOf(goSpans ?? [], "Thing")).toBe("type");
    const [rustSpans] = spansOf("rs", "let x: Option<u32> = Some(3u32);");
    expect(classOf(rustSpans ?? [], "Option")).toBe("type");
    expect(classOf(rustSpans ?? [], "Some")).toBe("constant");
    expect(classOf(rustSpans ?? [], "3u32")).toBe("constant");
  });

  it("colors diff lines by their leading mark only", () => {
    const [hunk, added, removed, context] = spansOf(
      "diff",
      "@@ -1 +1 @@",
      "+new line",
      "-old line",
      " unchanged",
    );
    expect(hunk).toEqual([{ text: "@@ -1 +1 @@", syntax: "hunk" }]);
    expect(added).toEqual([{ text: "+new line", syntax: "added" }]);
    expect(removed).toEqual([{ text: "-old line", syntax: "removed" }]);
    expect(context).toEqual([{ text: " unchanged" }]);
  });

  it("marks markdown headings, list leads, and code spans inside fences", () => {
    const [heading, item] = spansOf("md", "## Title", "- see `bun test` now");
    expect(heading).toEqual([{ text: "## Title", syntax: "keyword" }]);
    expect(item).toEqual([
      { text: "- ", syntax: "punctuation" },
      { text: "see " },
      { text: "`bun test`", syntax: "string" },
      { text: " now" },
    ]);
  });

  it("merges adjacent same-class runs so spans stay few", () => {
    const [spans] = spansOf("ts", "a   b");
    expect(spans).toEqual([{ text: "a   b" }]);
  });

  it("stays linear over a five-thousand-line block", () => {
    const highlighter = highlighterFor("ts");
    const line =
      'export const value = compute("text", 12.5, /* note */ [a, b]) ?? fallback; // end';
    const startedAt = performance.now();
    for (let index = 0; index < 5000; index += 1) highlighter.line(line);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it("lists the languages it serves", () => {
    expect(highlightedLanguages()).toEqual(
      expect.arrayContaining(["ts", "js", "json", "sh", "py", "go", "rs", "diff", "md"]),
    );
  });
});
