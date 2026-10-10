import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sessionHtml } from "./export-html.ts";

const tempDir = scratchDirs("keywork-export-html-");

const exportedAt = new Date("2026-10-02T12:00:00.000Z");

describe("sessionHtml", () => {
  it("renders every entry type on the active path", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).toContain("<title>Export &lt;fixture&gt;</title>");
    expect(html).toContain("named Export &lt;fixture&gt;");
    expect(html).toContain("model → openai/gpt-5");
    expect(html).toContain("thinking → on");
    expect(html).toContain("effort → high");
    expect(html).toContain("arc → billing");
    expect(html).toContain("context folded · 1,200 tokens summarized");
    expect(html).toContain("branch summary · from e6");
    expect(html).toContain("the other road");
    expect(html).toContain('<p class="marker">probe</p>');
    expect(html).toContain("visible &lt;note&gt;");
    expect(html).toContain("label best &quot;one&quot; on e9");
  });

  it("escapes every piece of session text and runs nothing", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; fix it");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("secret plan &lt;b&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(html).not.toMatch(/<link|src="http|href="http/i);
    expect(html).toContain("default-src 'none'");
    expect(wellFormed(html)).toEqual({ balanced: true, strayAngles: [] });
  });

  it("shows hidden characters instead of letting them reorder text", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).not.toContain("‮");
    expect(html).toContain('<span class="hidden-char">U+202E</span>');
  });

  it("folds thinking and pairs each tool call with its result", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).toContain('<details class="thinking"><summary>thinking</summary>');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("thinking sealed by the provider");
    const bash = sliceFrom(html, "<b>bash</b>", "</details>");
    expect(bash).toContain('<span class="status">ok</span>');
    expect(bash).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<b>result</b>");
    const search = sliceFrom(html, "<b>github__search</b>", "</details>");
    expect(search).toContain("no result");
    expect(html).toContain('<span class="glyph">░</span> <b>github__search</b>');
  });

  it("prices each turn under the model in force and totals the session", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).toContain('<footer class="usage">1,000 in · 100 out · $0.0022</footer>');
    expect(html).toContain('<footer class="usage">10 in · 5 out · 400 cached · $');
    expect(html).toMatch(/<dt>cost<\/dt><dd>\$0\.00\d+<\/dd>/);
  });

  it("embeds safe images inline and leaves the rest out", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).toContain('<img alt="attached image" src="data:image/png;base64,iVBORw0KGgo=">');
    expect(html).toContain("image (text/html) left out");
  });

  it("keeps the inactive branch out of the path view", async () => {
    const html = sessionHtml(await fixtureSession(), "path", exportedAt);

    expect(html).not.toContain("the road not taken");
    expect(html).not.toContain('class="fork"');
  });

  it("draws the whole tree with its branch points", async () => {
    const html = sessionHtml(await fixtureSession(), "tree", exportedAt);

    expect(html).toContain("<dd>every branch</dd>");
    expect(html).toContain("branch 1 of 2</p>");
    expect(html).toContain("branch 2 of 2 · active</p>");
    expect(html).toContain('<section class="branch active">');
    expect(html).toContain("the road not taken");
    expect(html).toContain("context folded · 1,200 tokens summarized");
    expect(wellFormed(html)).toEqual({ balanced: true, strayAngles: [] });
  });
});

async function fixtureSession(): Promise<SessionStore> {
  const file = join(await tempDir(), "fixture.jsonl");
  await writeFile(file, `${fixtureLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return SessionStore.open(file);
}

const at = (minute: number) => `2026-10-02T10:${String(minute).padStart(2, "0")}:00.000Z`;

const fixtureLines = [
  { type: "session", version: 3, id: "sess-1", timestamp: at(0), cwd: "/work" },
  { type: "session_info", id: "e1", parentId: null, timestamp: at(1), name: "Export <fixture>" },
  {
    type: "model_change",
    id: "e2",
    parentId: "e1",
    timestamp: at(2),
    provider: "openai",
    modelId: "gpt-5",
  },
  {
    type: "thinking_level_change",
    id: "e3",
    parentId: "e2",
    timestamp: at(3),
    thinkingLevel: "on",
  },
  { type: "effort_change", id: "e4", parentId: "e3", timestamp: at(4), effort: "high" },
  { type: "binding", id: "e5", parentId: "e4", timestamp: at(5), arc: "billing" },
  {
    type: "message",
    id: "e6",
    parentId: "e5",
    timestamp: at(6),
    message: {
      role: "user",
      parts: [
        { type: "text", text: "<script>alert(1)</script> fix it" },
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { type: "image", mediaType: "text/html", data: "PGgxPg==" },
      ],
    },
  },
  {
    type: "message",
    id: "e7",
    parentId: "e6",
    timestamp: at(7),
    usage: { inputTokens: 1000, outputTokens: 100 },
    message: {
      role: "assistant",
      parts: [
        { type: "thinking", thinking: "secret plan <b>", signature: "sig" },
        { type: "text", text: "On it." },
        { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "echo '<x>'" } },
        { type: "tool-call", callId: "c2", name: "github__search", arguments: { q: "x" } },
      ],
    },
  },
  {
    type: "message",
    id: "e8",
    parentId: "e7",
    timestamp: at(8),
    message: {
      role: "tool",
      parts: [
        {
          type: "tool-result",
          callId: "c1",
          output: "<img src=x onerror=alert(1)>",
          isError: false,
        },
      ],
    },
  },
  {
    type: "message",
    id: "e9",
    parentId: "e8",
    timestamp: at(9),
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 400 },
    message: {
      role: "assistant",
      parts: [
        { type: "redacted-thinking", data: "opaque" },
        { type: "text", text: "done ‮ evil" },
      ],
    },
  },
  {
    type: "message",
    id: "e15",
    parentId: "e9",
    timestamp: at(10),
    message: { role: "user", parts: [{ type: "text", text: "the road not taken" }] },
  },
  {
    type: "compaction",
    id: "e10",
    parentId: "e9",
    timestamp: at(11),
    summary: "folded <stuff>",
    firstKeptEntryId: "e9",
    tokensBefore: 1200,
  },
  {
    type: "branch_summary",
    id: "e11",
    parentId: "e10",
    timestamp: at(12),
    fromId: "e6",
    summary: "the other road",
  },
  { type: "custom", id: "e12", parentId: "e11", timestamp: at(13), customType: "probe" },
  {
    type: "custom_message",
    id: "e13",
    parentId: "e12",
    timestamp: at(14),
    customType: "note",
    content: "visible <note>",
    display: true,
  },
  {
    type: "label",
    id: "e14",
    parentId: "e13",
    timestamp: at(15),
    targetId: "e9",
    label: 'best "one"',
  },
];

function sliceFrom(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  return from === -1 ? "" : html.slice(from, html.indexOf(end, from));
}

const voidElements = new Set(["meta", "img", "br", "hr", "link", "input"]);

function wellFormed(html: string): { balanced: boolean; strayAngles: string[] } {
  const open: string[] = [];
  let balanced = true;
  const withoutStyle = html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const [, closing, name] of withoutStyle.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/gi)) {
    const tag = (name ?? "").toLowerCase();
    if (voidElements.has(tag)) continue;
    if (closing === "") open.push(tag);
    else if (open.pop() !== tag) balanced = false;
  }
  const text = withoutStyle
    .replace(/^<!doctype html>/i, "")
    .replace(/<\/?[a-z][a-z0-9]*\b[^<>]*>/gi, "");
  const strayAngles = text.match(/[<>]/g) ?? [];
  return { balanced: balanced && open.length === 0, strayAngles };
}
