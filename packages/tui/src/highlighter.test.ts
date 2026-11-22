import { describe, expect, it } from "vitest";
import { highlighterFor, type SyntaxSpan } from "./highlighter.ts";

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

  it("reads shell variables and boundary-only comments", () => {
    const [spans] = spansOf("sh", `echo "$HOME" \${USER} a#b # done`);
    expect(classOf(spans ?? [], "echo")).toBe("keyword");
    expect(classOf(spans ?? [], `\${USER}`)).toBe("type");
    expect(classOf(spans ?? [], "a#b")).toBeUndefined();
    expect(classOf(spans ?? [], "# done")).toBe("comment");
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
});
