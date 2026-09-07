import { Agent, MockProvider, type TickScheduler, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { type MarkdownRow, renderMarkdown } from "./markdown.ts";
import { pageMarks } from "./marks.ts";
import { resolvePage } from "./page.ts";
import { type TranscriptEntry, TranscriptFeed } from "./transcript-feed.ts";
import {
  type TranscriptSource,
  TranscriptView,
  transcriptLines,
  windowFromEnd,
} from "./transcript-view.ts";
import { width } from "./width.ts";

function sourceOf(entries: TranscriptEntry[]): TranscriptSource {
  return { entries, streamingProgress: () => undefined };
}

function assistantLines(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, at) => ({
    kind: "assistant" as const,
    text: `entry ${at + 1}`,
  }));
}

function countingMarkdown(): { render: typeof renderMarkdown; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    render: (source, prose, bleed, marks): MarkdownRow[] => {
      calls.push(source.split("\n").length);
      return renderMarkdown(source, prose, bleed, marks);
    },
  };
}

describe("transcriptLines", () => {
  it("prefixes user entries and wraps long lines to width", () => {
    const lines = transcriptLines(
      [
        { kind: "user", text: "abcdefgh" },
        { kind: "assistant", text: "12345" },
      ],
      5,
    );
    expect(lines.map((line) => line.text)).toEqual(["› abc", "  def", "  gh", "12345"]);
  });

  it("splits embedded newlines", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "a\nb" }], 10);
    expect(lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  it("never splits surrogate pairs when wrapping astral-plane text", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "😀".repeat(7) }], 6);
    expect(lines.map((line) => line.text)).toEqual(["😀😀😀", "😀😀😀", "😀"]);
    for (const line of lines) {
      expect(line.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("wraps CJK text by display cells, two per character", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "我们在这里写字" }], 4);
    expect(lines.map((line) => line.text)).toEqual(["我们", "在这", "里写", "字"]);
    for (const line of lines) expect(width(line.text)).toBeLessThanOrEqual(4);
  });
});

describe("windowed transcript", () => {
  it("matches the full wrap-and-slice result at the live edge and scrolled", () => {
    const entries = assistantLines(500);
    const view = new TranscriptView();
    const full = transcriptLines(entries, 40).map((line) => line.text);
    const texts = (scrollBack: number) =>
      view
        .frame(sourceOf(entries), { width: 40, rows: 8 }, { scrollBack })
        .lines.map((l) => l.text);

    expect(texts(0)).toEqual(full.slice(-8));
    expect(texts(100)).toEqual(full.slice(-108, -100));
  });

  it("clamps a scroll past the top to the oldest window", () => {
    const entries = assistantLines(500);
    const frame = new TranscriptView().frame(
      sourceOf(entries),
      { width: 40, rows: 8 },
      { scrollBack: 100_000 },
    );
    expect(frame.lines[0]?.text).toBe("entry 1");
    expect(frame.scrollBack).toBe(500 - 8);
  });

  it("reveals a requested entry by scrolling it into the bottom of the window", () => {
    const entries = assistantLines(50);
    const frame = new TranscriptView().frame(
      sourceOf(entries),
      { width: 40, rows: 5 },
      { scrollBack: 0, revealAt: 9 },
    );
    expect(frame.lines[0]?.text).toBe("entry 10");
    expect(frame.scrollBack).toBe(36);
  });

  it("selects the whole backtracked entry and only the head of the fold cursor", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "a\nb" },
      { kind: "tool", text: "bash", failed: false },
    ];
    const view = new TranscriptView();
    const back = view.frame(
      sourceOf(entries),
      { width: 40, rows: 5 },
      { scrollBack: 0, backtrackAt: 0 },
    );
    expect(back.lines.map((line) => line.selected)).toEqual([true, true, undefined]);
    const fold = view.frame(
      sourceOf(entries),
      { width: 40, rows: 5 },
      { scrollBack: 0, foldCursor: 0 },
    );
    expect(fold.lines.map((line) => line.selected)).toEqual([true, undefined, undefined]);
  });

  it("materializes only the entries inside the viewport when scrolled to the middle", () => {
    const materialized: number[] = [];
    const frame = windowFromEnd(
      5_000,
      () => 1,
      (index) => {
        materialized.push(index);
        return [{ kind: "info", failed: false, text: `line ${index}` }];
      },
      2_500,
      8,
    );
    expect(frame.lines.map((line) => line.text)).toEqual(
      Array.from({ length: 8 }, (_, at) => `line ${2_492 + at}`),
    );
    expect(materialized).toHaveLength(8);
  });

  it("never touches entries above the window while locating it", () => {
    const counted: number[] = [];
    const frame = windowFromEnd(
      100,
      (index) => {
        counted.push(index);
        return 3;
      },
      () => [
        { kind: "info", failed: false, text: "x" },
        { kind: "info", failed: false, text: "y" },
        { kind: "info", failed: false, text: "z" },
      ],
      10,
      4,
    );
    expect(frame.lines).toHaveLength(4);
    expect(Math.min(...counted)).toBe(95);
  });
});

describe("incremental streaming render", () => {
  it("re-renders only the trailing block as deltas arrive, O(N) lines over N deltas", () => {
    const markdown = countingMarkdown();
    const view = new TranscriptView(markdown.render);
    const entry: TranscriptEntry = { kind: "assistant", text: "" };
    const source = sourceOf([entry]);
    const deltas = 200;
    for (let at = 0; at < deltas; at += 1) {
      entry.text += at % 7 === 6 ? `word ${at}\n` : `word ${at} `;
      view.frame(source, { width: 60, rows: 20 }, { scrollBack: 0 });
    }
    const linesRendered = markdown.calls.reduce((sum, lines) => sum + lines, 0);
    expect(linesRendered).toBeLessThanOrEqual(deltas * 2);
    const whole = new TranscriptView().frame(
      sourceOf([{ ...entry }]),
      { width: 60, rows: 20 },
      {
        scrollBack: 0,
      },
    );
    const streamed = view.frame(source, { width: 60, rows: 20 }, { scrollBack: 0 });
    expect(streamed.lines.map((line) => line.text)).toEqual(whole.lines.map((line) => line.text));
  });

  it("keeps an open fence as one growing block and renders it identically to a whole pass", () => {
    const markdown = countingMarkdown();
    const view = new TranscriptView(markdown.render);
    const entry: TranscriptEntry = { kind: "assistant", text: "intro\n```ts\n" };
    const source = sourceOf([entry]);
    for (let at = 0; at < 30; at += 1) {
      entry.text += `const v${at} = ${at};\n`;
      view.frame(source, { width: 60, rows: 40 }, { scrollBack: 0 });
    }
    entry.text += "```\nafter";
    const streamed = view.frame(source, { width: 60, rows: 40 }, { scrollBack: 0 });
    const whole = new TranscriptView().frame(
      sourceOf([{ ...entry }]),
      { width: 60, rows: 40 },
      {
        scrollBack: 0,
      },
    );
    expect(streamed.lines.map((line) => line.text)).toEqual(whole.lines.map((line) => line.text));
    expect(markdown.calls.filter((lines) => lines === 1).length).toBeGreaterThan(0);
  });

  it("re-renders everything when the text is rewritten rather than appended", () => {
    const markdown = countingMarkdown();
    const view = new TranscriptView(markdown.render);
    const entry: TranscriptEntry = { kind: "assistant", text: "one\ntwo" };
    const source = sourceOf([entry]);
    view.frame(source, { width: 60, rows: 20 }, { scrollBack: 0 });
    entry.text = "uno\ntwo";
    const frame = view.frame(source, { width: 60, rows: 20 }, { scrollBack: 0 });
    expect(frame.lines.map((line) => line.text)).toEqual(["uno", "two"]);
  });
});

describe("the page grammar in the transcript", () => {
  const frame = (entries: TranscriptEntry[], width: number, rows: number, columns = width + 6) =>
    new TranscriptView().frame(
      sourceOf(entries),
      { width, rows, page: resolvePage(columns) },
      { scrollBack: 0 },
    ).lines;

  it("wraps prose to the broadsheet measure while machine output runs full bleed", () => {
    const lines = frame(
      [
        { kind: "assistant", text: "word ".repeat(40).trim() },
        { kind: "tool", text: `· bash ${"x".repeat(140)}`, failed: false },
      ],
      150,
      60,
    );
    const prose = lines.filter((line) => line.kind === "assistant");
    const machine = lines.filter((line) => line.kind === "tool");
    expect(prose.length).toBeGreaterThan(1);
    for (const line of prose) expect(line.text.length).toBeLessThanOrEqual(89);
    expect(Math.max(...machine.map((line) => line.text.length))).toBe(147);
  });

  it("indents prose by the gutter and leaves machine output on the margin", () => {
    const lines = frame(
      [
        { kind: "user", text: "go" },
        { kind: "tool", text: "✓ bash · ok", failed: false },
      ],
      150,
      60,
    );
    expect(lines.find((line) => line.kind === "user")?.text).toBe(" go");
    expect(lines.find((line) => line.kind === "tool")?.text).toBe("✓ bash · ok");
  });

  it("re-wraps when a resize crosses a tier threshold", () => {
    const entries: TranscriptEntry[] = [{ kind: "assistant", text: "word ".repeat(40).trim() }];
    const view = new TranscriptView();
    const broad = view.frame(
      sourceOf(entries),
      { width: 150, rows: 60, page: resolvePage(156) },
      { scrollBack: 0 },
    ).lines;
    const column = view.frame(
      sourceOf(entries),
      { width: 76, rows: 60, page: resolvePage(80) },
      { scrollBack: 0 },
    ).lines;
    expect(Math.max(...broad.map((line) => line.text.length))).toBeLessThanOrEqual(89);
    expect(Math.max(...column.map((line) => line.text.length))).toBeLessThanOrEqual(76);
    expect(column.map((line) => line.text)).not.toEqual(broad.map((line) => line.text));
    expect(column[0]?.text.startsWith(" ")).toBe(false);
  });

  it("renders assistant markdown as styled spans and user text verbatim", () => {
    const lines = frame(
      [
        { kind: "user", text: "**not markdown**" },
        { kind: "assistant", text: "**bold**" },
      ],
      60,
      10,
      60,
    );
    const user = lines.find((line) => line.kind === "user");
    const assistant = lines.find((line) => line.kind === "assistant");
    expect(user?.text).toBe("**not markdown**");
    expect(user?.spans).toBeUndefined();
    expect(assistant?.text).toBe("bold");
    expect(assistant?.spans).toContainEqual({ text: "bold", tone: "body", bold: true });
  });

  it("runs fence rows on the panel past the prose measure", () => {
    const wide = "x".repeat(100);
    const lines = frame([{ kind: "assistant", text: `\`\`\`ts\n${wide}\n\`\`\`` }], 120, 60);
    const fenceRows = lines.filter((line) => line.panel === true);
    expect(fenceRows.map((line) => line.text)).toEqual(["▎ ts", `▎ ${wide}`]);
    expect(lines.some((line) => line.text.includes("```"))).toBe(false);
  });
});

describe("the voice rail and tool rows", () => {
  it("stamps entries by voice and blanks continuation rows", () => {
    const lines = new TranscriptView().frame(
      sourceOf([
        { kind: "user", text: "go" },
        { kind: "assistant", text: "word ".repeat(20).trim() },
        { kind: "info", text: "a notice" },
      ]),
      { width: 30, rows: 40 },
      { scrollBack: 0 },
    ).lines;
    const user = lines.find((line) => line.kind === "user");
    const prose = lines.filter((line) => line.kind === "assistant");
    const info = lines.find((line) => line.kind === "info");
    expect(user?.stamp).toBe("█ ");
    expect(prose[0]?.stamp).toBe("▓ ");
    expect(prose.slice(1).every((line) => line.stamp === "  ")).toBe(true);
    expect(prose.length).toBeGreaterThan(1);
    expect(info?.stamp).toBe("  ");
    for (const line of lines) expect(width(line.text)).toBeLessThanOrEqual(28);
  });

  it("steps the streaming stamp through the ramp and settles it on interrupt", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const ticks: (() => void)[] = [];
    const tick: TickScheduler = (flush) => {
      ticks.push(flush);
    };
    const feed = new TranscriptFeed(() => {}, undefined, tick);
    feed.follow(agent.bus);
    const view = new TranscriptView();
    const stamp = () =>
      view
        .frame(feed, { width: 60, rows: 20 }, { scrollBack: 0 })
        .lines.find((line) => line.kind === "assistant")?.stamp;
    const delta = (text: string) => {
      agent.bus.emit("turn.delta", { delta: { type: "text", text } });
      for (const flush of ticks.splice(0)) flush();
    };

    delta("one ");
    expect(stamp()).toBe("░ ");
    delta("two ");
    delta("three ");
    expect(stamp()).toBe("▒ ");
    agent.bus.emit("turn.interrupted", { message: textMessage("assistant", "one two three") });
    expect(stamp()).toBe("▓ ");
  });

  it("clips an overlong tool row with an ellipsis instead of wrapping", () => {
    const lines = new TranscriptView().frame(
      sourceOf([
        {
          kind: "tool",
          text: "",
          failed: false,
          run: {
            name: "echo",
            subject: "x".repeat(120),
            args: "{}",
            replay: false,
            startedAtMs: 0,
            folded: true,
            outcome: "done",
            durationMs: 3,
            detail: ["ok"],
          },
        },
      ]),
      { width: 40, rows: 40 },
      { scrollBack: 0 },
    ).lines;
    expect(lines).toHaveLength(1);
    expect(width(lines[0]?.text ?? "")).toBeLessThanOrEqual(38);
    expect(lines[0]?.text.endsWith("…")).toBe(true);
  });

  it("discloses detail under a rule when a run is unfolded", () => {
    const run = {
      name: "echo",
      subject: "hi",
      args: '{"text":"hi"}',
      replay: false,
      startedAtMs: 0,
      folded: false,
      outcome: "done" as const,
      durationMs: 3,
      detail: ["echo: hi"],
    };
    const lines = new TranscriptView().frame(
      sourceOf([{ kind: "tool", text: "", failed: false, run }]),
      { width: 80, rows: 40 },
      { scrollBack: 0 },
    ).lines;
    expect(lines[0]?.spans).toContainEqual({ text: "done", tone: "ok" });
    expect(lines[0]?.stamp).toBe("░ ");
    expect(lines[1]?.spans?.[0]?.tone).toBe("rule");
    expect(lines.map((line) => line.text).slice(2)).toEqual(['{"text":"hi"}', "echo: hi"]);
    expect(lines.slice(1).every((line) => line.stamp === "  ")).toBe(true);
  });
});

describe("thinking parts", () => {
  const thought = "First weigh the options, then pick the shorter road.";

  it("renders a folded thinking part as one meta row under the agent stamp", () => {
    const lines = new TranscriptView().frame(
      sourceOf([{ kind: "thinking", text: thought, folded: true }]),
      { width: 80, rows: 40 },
      { scrollBack: 0 },
    ).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "thinking",
      stamp: "▓ ",
      text: "thinking · 9 words",
      spans: [{ text: "thinking · 9 words", tone: "meta" }],
    });
  });

  it("discloses the reasoning as meta prose under a rule when unfolded", () => {
    const lines = new TranscriptView().frame(
      sourceOf([{ kind: "thinking", text: `${thought}\n\nThen go.`, folded: false }]),
      { width: 80, rows: 40 },
      { scrollBack: 0 },
    ).lines;
    expect(lines[1]?.spans?.[0]?.tone).toBe("rule");
    expect(lines.slice(2).map((line) => line.text)).toEqual([thought, "", "Then go."]);
    expect(lines.slice(2).every((line) => line.spans?.[0]?.tone === "meta")).toBe(true);
    expect(lines.slice(1).every((line) => line.stamp === "  ")).toBe(true);
  });

  it("re-renders when the fold flips without a text change", () => {
    const entry: TranscriptEntry = { kind: "thinking", text: thought, folded: true };
    const view = new TranscriptView();
    const geometry = { width: 80, rows: 40 };
    expect(view.frame(sourceOf([entry]), geometry, { scrollBack: 0 }).lines).toHaveLength(1);
    entry.folded = false;
    expect(view.frame(sourceOf([entry]), geometry, { scrollBack: 0 }).lines).toHaveLength(3);
  });
});

describe("tiered transcript marks", () => {
  it("stamps voice and rules in ASCII at glyph tier 0", () => {
    const ascii = pageMarks({ glyphTier: 0, nerdFont: false });
    const lines = new TranscriptView().frame(
      sourceOf([
        { kind: "user", text: "go" },
        {
          kind: "tool",
          text: "",
          failed: false,
          run: {
            name: "echo",
            subject: "hi",
            args: "{}",
            replay: false,
            startedAtMs: 0,
            folded: false,
            outcome: "done",
            detail: ["echo: hi"],
          },
        },
        { kind: "assistant", text: "# Title\nbody" },
      ]),
      { width: 80, rows: 40, page: resolvePage(80), marks: ascii },
      { scrollBack: 0 },
    ).lines;
    expect(lines.map((line) => line.stamp)).toEqual(["# ", ". ", "  ", "  ", "+ ", "  "]);
    expect(lines[2]?.text).toBe("-".repeat(78));
    expect(lines[4]?.text).toBe("= Title");
  });
});

describe("the streaming cursor", () => {
  it("marks the streaming entry's last line and lifts it when the stream settles", () => {
    const entries: TranscriptEntry[] = [{ kind: "assistant", text: "hello there" }];
    const view = new TranscriptView();
    const streaming: TranscriptSource = {
      entries,
      streamingProgress: (entry) => (entry === entries[0] ? 0.5 : undefined),
    };
    const live = view.frame(streaming, { width: 40, rows: 5 }, { scrollBack: 0 });
    expect(live.lines.at(-1)?.text.endsWith("▌")).toBe(true);
    expect(live.lines.at(-1)?.spans?.at(-1)).toEqual({ text: "▌", tone: "meta" });

    const settled = view.frame(sourceOf(entries), { width: 40, rows: 5 }, { scrollBack: 0 });
    expect(settled.lines.at(-1)?.text.endsWith("▌")).toBe(false);
  });

  it("degrades the cursor to ascii at glyph tier 0", () => {
    const entries: TranscriptEntry[] = [{ kind: "assistant", text: "plain" }];
    const view = new TranscriptView();
    const live = view.frame(
      { entries, streamingProgress: () => 0.5 },
      { width: 40, rows: 5, marks: pageMarks({ glyphTier: 0, nerdFont: false }) },
      { scrollBack: 0 },
    );
    expect(live.lines.at(-1)?.text.endsWith("_")).toBe(true);
  });
});

describe("scroll stability while streaming", () => {
  it("keeps the anchored viewport put as new lines arrive below", () => {
    const entries = assistantLines(30);
    const view = new TranscriptView();
    const geometry = { width: 40, rows: 5 };
    const first = view.frame(sourceOf(entries), geometry, { scrollBack: 10 });
    expect(first.total).toBe(30);

    const grown = view.frame(sourceOf([...entries, ...assistantLines(3)]), geometry, {
      scrollBack: 10,
      anchorTotal: first.total,
    });
    expect(grown.scrollBack).toBe(13);
    expect(grown.lines.map((line) => line.text)).toEqual(first.lines.map((line) => line.text));
  });

  it("leaves the live viewport following the tail", () => {
    const entries = assistantLines(30);
    const view = new TranscriptView();
    const geometry = { width: 40, rows: 5 };
    const first = view.frame(sourceOf(entries), geometry, { scrollBack: 0 });
    const grown = view.frame(sourceOf([...entries, ...assistantLines(2)]), geometry, {
      scrollBack: 0,
      anchorTotal: first.total,
    });
    expect(grown.scrollBack).toBe(0);
    expect(grown.lines.at(-1)?.text).toContain("entry 2");
  });
});

describe("virtualized rows", () => {
  const geometry = { width: 60, rows: 20 };

  it("lays out O(visible) rows per frame over a 10,000-entry transcript", () => {
    const markdown = countingMarkdown();
    const view = new TranscriptView(markdown.render);
    const entries = assistantLines(10_000);
    const source = sourceOf(entries);
    view.frame(source, geometry, { scrollBack: 0 });
    expect(markdown.calls).toHaveLength(10_000);

    markdown.calls.length = 0;
    const tail = entries[entries.length - 1] as TranscriptEntry;
    for (let at = 0; at < 100; at += 1) {
      tail.text += ` more ${at}`;
      view.frame(source, geometry, { scrollBack: 0 });
    }
    expect(markdown.calls).toHaveLength(100);

    markdown.calls.length = 0;
    for (let at = 0; at < 100; at += 1) view.frame(source, geometry, { scrollBack: 5_000 + at });
    expect(markdown.calls).toHaveLength(0);

    entries[4_000] = { kind: "assistant", text: "rewritten" };
    view.frame(source, geometry, { scrollBack: 5_000 });
    expect(markdown.calls).toHaveLength(1);

    view.frame(source, { ...geometry, width: 50 }, { scrollBack: 0 });
    expect(markdown.calls).toHaveLength(10_001);
  });

  it("keeps the frame identical to a fresh view through growth, mutation, and truncation", () => {
    const entries = assistantLines(40);
    const view = new TranscriptView();
    const same = (scrollBack: number) => {
      const kept = view.frame(sourceOf(entries), geometry, { scrollBack });
      const fresh = new TranscriptView().frame(sourceOf(entries), geometry, { scrollBack });
      expect(kept.lines).toEqual(fresh.lines);
      expect(kept.total).toBe(fresh.total);
    };
    same(0);
    entries.push(...assistantLines(5));
    same(0);
    (entries[2] as TranscriptEntry).text = "word ".repeat(30).trim();
    same(30);
    entries.length = 3;
    same(0);
    entries.push({ kind: "user", text: "again" });
    same(0);
  });
});
