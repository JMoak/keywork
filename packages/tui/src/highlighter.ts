export type SyntaxClass =
  | "keyword"
  | "type"
  | "constant"
  | "string"
  | "comment"
  | "punctuation"
  | "added"
  | "removed"
  | "hunk";

export interface SyntaxSpan {
  readonly text: string;
  readonly syntax?: SyntaxClass;
}

export interface Highlighter {
  line(text: string): SyntaxSpan[];
}

export function highlighterFor(language: string): Highlighter {
  const grammar = grammars[aliases[language.toLowerCase()] ?? ""];
  if (grammar === undefined) return plainHighlighter;
  return typeof grammar === "function" ? { line: grammar } : new LexicalHighlighter(grammar);
}

export function highlightedLanguages(): string[] {
  return Object.keys(aliases);
}

type LineHighlighter = (text: string) => SyntaxSpan[];

interface Grammar {
  readonly keywords: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly constants: ReadonlySet<string>;
  readonly capitalizedTypes: boolean;
  readonly lineComment: string | undefined;
  readonly commentNeedsWordBoundary: boolean;
  readonly blockComment: readonly [open: string, close: string] | undefined;
  readonly quotes: readonly string[];
  readonly multilineStrings: readonly (readonly [open: string, close: string])[];
  readonly variable: RegExp | undefined;
  readonly keyStrings: boolean;
}

interface OpenBlock {
  readonly syntax: "comment" | "string";
  readonly close: string;
}

const plainHighlighter: Highlighter = {
  line: (text) => (text === "" ? [] : [{ text }]),
};

class LexicalHighlighter implements Highlighter {
  private open: OpenBlock | undefined;

  constructor(private readonly grammar: Grammar) {}

  line(text: string): SyntaxSpan[] {
    const spans: SyntaxSpan[] = [];
    let at = 0;
    while (at < text.length) {
      const open = this.open;
      const span =
        open === undefined ? this.scanToken(text, at) : this.continueBlock(text, at, open);
      push(spans, span);
      at += span.text.length;
    }
    return spans;
  }

  private continueBlock(text: string, at: number, open: OpenBlock): SyntaxSpan {
    const close = text.indexOf(open.close, at);
    if (close === -1) return { text: text.slice(at), syntax: open.syntax };
    this.open = undefined;
    return { text: text.slice(at, close + open.close.length), syntax: open.syntax };
  }

  private scanToken(text: string, at: number): SyntaxSpan {
    const grammar = this.grammar;
    const character = text[at] as string;
    if (/\s/.test(character)) return { text: runOf(text, at, /\s/) };
    if (this.startsLineComment(text, at)) return { text: text.slice(at), syntax: "comment" };
    const block = grammar.blockComment;
    if (block !== undefined && text.startsWith(block[0], at)) {
      return this.openBlock(text, at, block, "comment");
    }
    for (const fence of grammar.multilineStrings) {
      if (text.startsWith(fence[0], at)) return this.openBlock(text, at, fence, "string");
    }
    if (grammar.quotes.includes(character)) {
      const end = quotedEnd(text, at, character);
      const syntax = grammar.keyStrings && isObjectKey(text, end) ? "type" : "string";
      return { text: text.slice(at, end), syntax };
    }
    const variable = grammar.variable;
    if (variable !== undefined) {
      variable.lastIndex = at;
      const match = variable.exec(text);
      if (match !== null) return { text: match[0], syntax: "type" };
    }
    if (startsNumber(text, at)) {
      numberPattern.lastIndex = at;
      const match = numberPattern.exec(text);
      if (match !== null) return { text: match[0], syntax: "constant" };
    }
    if (/[A-Za-z_$]/.test(character)) {
      const word = runOf(text, at, /[\w$]/);
      return { text: word, ...classify(word, grammar) };
    }
    if (punctuation.has(character)) {
      return { text: runOf(text, at, punctuationRun), syntax: "punctuation" };
    }
    return { text: character };
  }

  private startsLineComment(text: string, at: number): boolean {
    const marker = this.grammar.lineComment;
    if (marker === undefined || !text.startsWith(marker, at)) return false;
    if (!this.grammar.commentNeedsWordBoundary) return true;
    return at === 0 || /[\s;|&(]/.test(text[at - 1] as string);
  }

  private openBlock(
    text: string,
    at: number,
    [open, close]: readonly [string, string],
    syntax: "comment" | "string",
  ): SyntaxSpan {
    const closeAt = text.indexOf(close, at + open.length);
    if (closeAt !== -1) return { text: text.slice(at, closeAt + close.length), syntax };
    this.open = { syntax, close };
    return { text: text.slice(at), syntax };
  }
}

function classify(word: string, grammar: Grammar): { syntax?: SyntaxClass } {
  if (grammar.keywords.has(word)) return { syntax: "keyword" };
  if (grammar.constants.has(word)) return { syntax: "constant" };
  if (grammar.types.has(word)) return { syntax: "type" };
  if (grammar.capitalizedTypes && /^[A-Z]/.test(word)) return { syntax: "type" };
  return {};
}

function push(spans: SyntaxSpan[], span: SyntaxSpan): void {
  if (span.text === "") return;
  const last = spans.at(-1);
  if (last !== undefined && last.syntax === span.syntax) {
    spans[spans.length - 1] = { ...last, text: last.text + span.text };
    return;
  }
  spans.push(span);
}

function runOf(text: string, at: number, member: RegExp): string {
  let end = at;
  while (end < text.length && member.test(text[end] as string)) end += 1;
  return text.slice(at, end);
}

function quotedEnd(text: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function isObjectKey(text: string, after: number): boolean {
  return /^\s*:/.test(text.slice(after));
}

function startsNumber(text: string, at: number): boolean {
  const character = text[at] as string;
  if (/\d/.test(character)) return true;
  return character === "." && /\d/.test(text[at + 1] ?? "");
}

const numberPattern =
  /0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?(?:n|[iu](?:8|16|32|64|128|size)|f32|f64|[jJ]|[lL])?/y;

const punctuation = new Set("{}()[];,.:+-*/=<>!&|^%~?@#\\");
const punctuationRun = /[{}()[\];,.:+\-*/=<>!&|^%~?@#\\]/;

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/));

const jsLike: Grammar = {
  keywords: words(
    "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of override package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  ),
  types: words(
    "any bigint boolean never number object string symbol unknown Array Promise Record Partial Readonly Pick Omit Map Set Date Error",
  ),
  constants: words("true false null undefined NaN Infinity"),
  capitalizedTypes: true,
  lineComment: "//",
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  multilineStrings: [["`", "`"]],
  variable: undefined,
  keyStrings: false,
};

const json: Grammar = {
  keywords: new Set(),
  types: new Set(),
  constants: words("true false null"),
  capitalizedTypes: false,
  lineComment: "//",
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  quotes: ['"'],
  multilineStrings: [],
  variable: undefined,
  keyStrings: true,
};

const shell: Grammar = {
  keywords: words(
    "if then elif else fi for while until do done case esac in function select time return exit export local readonly declare typeset source alias unalias unset shift break continue set eval exec trap echo printf read cd test",
  ),
  types: new Set(),
  constants: words("true false"),
  capitalizedTypes: false,
  lineComment: "#",
  commentNeedsWordBoundary: true,
  blockComment: undefined,
  quotes: ['"', "'"],
  multilineStrings: [],
  variable: /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[#?@*$!0-9-])/y,
  keyStrings: false,
};

const python: Grammar = {
  keywords: words(
    "and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
  ),
  types: words(
    "int str float bool list dict set tuple bytes object type self cls print len range super Exception",
  ),
  constants: words("True False None"),
  capitalizedTypes: true,
  lineComment: "#",
  commentNeedsWordBoundary: false,
  blockComment: undefined,
  quotes: ['"', "'"],
  multilineStrings: [
    ['"""', '"""'],
    ["'''", "'''"],
  ],
  variable: undefined,
  keyStrings: false,
};

const go: Grammar = {
  keywords: words(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  ),
  types: words(
    "any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
  ),
  constants: words("true false nil iota"),
  capitalizedTypes: true,
  lineComment: "//",
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  multilineStrings: [["`", "`"]],
  variable: undefined,
  keyStrings: false,
};

const rust: Grammar = {
  keywords: words(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  ),
  types: words(
    "bool char str String Vec Option Result Box Rc Arc i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64",
  ),
  constants: words("true false Some None Ok Err"),
  capitalizedTypes: true,
  lineComment: "//",
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  quotes: ['"'],
  multilineStrings: [],
  variable: undefined,
  keyStrings: false,
};

const diffLine: LineHighlighter = (text) => {
  if (text === "") return [];
  if (/^(\+\+\+|---|@@|diff |index )/.test(text)) return [{ text, syntax: "hunk" }];
  if (text.startsWith("+")) return [{ text, syntax: "added" }];
  if (text.startsWith("-")) return [{ text, syntax: "removed" }];
  return [{ text }];
};

const markdownLine: LineHighlighter = (text) => {
  if (text === "") return [];
  if (/^#{1,6} /.test(text)) return [{ text, syntax: "keyword" }];
  if (/^ {0,3}(`{3,}|~{3,})/.test(text) || /^\s*>/.test(text)) return [{ text, syntax: "comment" }];
  const marker = /^(\s*(?:[-*+]|\d+[.)]) )/.exec(text);
  const lead = marker?.[1] ?? "";
  const spans: SyntaxSpan[] = lead === "" ? [] : [{ text: lead, syntax: "punctuation" }];
  for (const piece of text.slice(lead.length).split(/(`[^`]*`)/)) {
    if (piece === "") continue;
    push(
      spans,
      piece.startsWith("`") && piece.endsWith("`")
        ? { text: piece, syntax: "string" }
        : { text: piece },
    );
  }
  return spans;
};

const grammars: Readonly<Record<string, Grammar | LineHighlighter>> = {
  jsLike,
  json,
  shell,
  python,
  go,
  rust,
  diff: diffLine,
  markdown: markdownLine,
};

const aliases: Readonly<Record<string, keyof typeof grammars>> = {
  ts: "jsLike",
  typescript: "jsLike",
  tsx: "jsLike",
  js: "jsLike",
  javascript: "jsLike",
  jsx: "jsLike",
  mjs: "jsLike",
  cjs: "jsLike",
  json: "json",
  jsonc: "json",
  json5: "json",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
};
