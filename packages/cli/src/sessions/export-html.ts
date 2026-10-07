import {
  costNanosOf,
  describeBinding,
  describeContextEdit,
  formatCostNanos,
  knownCostNanos,
  type Message,
  type Part,
  type SessionEntry,
  type SessionHeader,
  type SessionTreeNode,
  sessionCost,
  type ToolCallPart,
  type ToolResultPart,
  type Usage,
} from "@keywork/engine";
import { compactJson } from "../text.ts";

export type ExportScope = "path" | "tree";

export interface ExportableSession {
  readonly header: SessionHeader;
  name(): string | undefined;
  activePath(): SessionEntry[];
  tree(): SessionTreeNode[];
  labels(): ReadonlyMap<string, string>;
}

export function sessionHtml(
  session: ExportableSession,
  scope: ExportScope = "path",
  exportedAt: Date = new Date(),
): string {
  const title = session.name() ?? `session ${session.header.id.slice(0, 8)}`;
  const entries = scope === "path" ? session.activePath() : flatten(session.tree());
  const rendering: Rendering = {
    labels: session.labels(),
    results: resultsByCallId(entries),
    modelId: undefined,
  };
  const body =
    scope === "path" ? chainOf(entries, rendering) : levelHtml(session.tree(), rendering);
  return page(title, masthead(session, title, scope, entries, exportedAt), body);
}

interface Rendering {
  labels: ReadonlyMap<string, string>;
  results: ReadonlyMap<string, ToolResultPart>;
  modelId: string | undefined;
}

const glyphs = { user: "█", agent: "▓", external: "░" } as const;

function page(title: string, header: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${contentPolicy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="keywork">',
    `<title>${text(title)}</title>`,
    `<style>${stylesheet}</style>`,
    "</head>",
    "<body>",
    header,
    `<main>${body}</main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function masthead(
  session: ExportableSession,
  title: string,
  scope: ExportScope,
  entries: readonly SessionEntry[],
  exportedAt: Date,
): string {
  const facts: Array<[string, string]> = [
    ["session", session.header.id],
    ["folder", session.header.cwd],
    ["started", stamp(session.header.timestamp)],
    ["exported", stamp(exportedAt.toISOString())],
    ["showing", scope === "path" ? "the active path" : "every branch"],
    ["cost", costLine(entries)],
  ];
  const rows = facts.map(([term, value]) => `<dt>${term}</dt><dd>${text(value)}</dd>`).join("");
  return `<header class="masthead"><h1>${text(title)}</h1><dl>${rows}</dl></header>`;
}

function costLine(entries: readonly SessionEntry[]): string {
  const rollup = sessionCost(entries);
  const known = knownCostNanos(rollup);
  if (known !== undefined) return formatCostNanos(known);
  if (rollup.pricedTurns === 0) return "unpriced";
  return `${formatCostNanos(rollup.nanos)} plus ${rollup.unpricedTurns} unpriced`;
}

function levelHtml(nodes: readonly SessionTreeNode[], rendering: Rendering): string {
  if (nodes.length === 0) return "";
  const [only] = nodes;
  if (nodes.length === 1 && only !== undefined) return chainFrom(only, rendering);
  return forkHtml(nodes, rendering);
}

function chainFrom(start: SessionTreeNode, rendering: Rendering): string {
  const entries = [start.entry];
  let node = start;
  for (let next = onlyChild(node); next !== undefined; next = onlyChild(node)) {
    node = next;
    entries.push(node.entry);
  }
  const chain = chainOf(entries, rendering);
  return node.children.length > 1 ? blocks([chain, forkHtml(node.children, rendering)]) : chain;
}

function onlyChild(node: SessionTreeNode): SessionTreeNode | undefined {
  return node.children.length === 1 ? node.children[0] : undefined;
}

function forkHtml(children: readonly SessionTreeNode[], rendering: Rendering): string {
  const branches = children.map((child, index) => {
    const active = child.onActivePath ? " active" : "";
    const heading = `branch ${index + 1} of ${children.length}${child.onActivePath ? " · active" : ""}`;
    const body = chainFrom(child, { ...rendering });
    return `<section class="branch${active}"><p class="branch-head">${heading}</p>${body}</section>`;
  });
  return `<div class="fork">${blocks(branches)}</div>`;
}

function chainOf(entries: readonly SessionEntry[], rendering: Rendering): string {
  return blocks(entries.map((entry) => entryHtml(entry, rendering)));
}

function blocks(rendered: readonly string[]): string {
  return rendered.filter((block) => block !== "").join("\n");
}

function entryHtml(entry: SessionEntry, rendering: Rendering): string {
  const label = labelPill(rendering.labels.get(entry.id));
  switch (entry.type) {
    case "message":
      return messageHtml(entry.id, entry.timestamp, entry.message, entry.usage, label, rendering);
    case "compaction":
      return foldHtml(
        `context folded · ${entry.tokensBefore.toLocaleString("en-US")} tokens summarized`,
        entry.summary,
        label,
      );
    case "branch_summary":
      return foldHtml(`branch summary · from ${entry.fromId.slice(0, 8)}`, entry.summary, label);
    case "custom_message":
      return entry.display
        ? foldHtml(entry.customType, entry.content, label)
        : markerHtml(entry.customType, label);
    case "model_change":
      rendering.modelId = entry.modelId;
      return markerHtml(`model → ${entry.provider}/${entry.modelId}`, label);
    default:
      return markerHtml(markerText(entry), label);
  }
}

function markerText(
  entry: Exclude<
    SessionEntry,
    { type: "message" | "compaction" | "branch_summary" | "custom_message" | "model_change" }
  >,
): string {
  switch (entry.type) {
    case "label":
      return entry.label === undefined
        ? `label cleared on ${entry.targetId.slice(0, 8)}`
        : `label ${entry.label} on ${entry.targetId.slice(0, 8)}`;
    case "session_info":
      return `named ${entry.name ?? "(unnamed)"}`;
    case "thinking_level_change":
      return `thinking → ${entry.thinkingLevel}`;
    case "effort_change":
      return `effort → ${entry.effort}`;
    case "binding":
      return describeBinding(entry);
    case "context_edit":
      return describeContextEdit(entry);
    case "custom":
      return entry.customType;
  }
}

function messageHtml(
  id: string,
  timestamp: string,
  message: Message,
  usage: Usage | undefined,
  label: string,
  rendering: Rendering,
): string {
  const parts = message.parts.map((part) => partHtml(part, rendering)).join("");
  if (message.role === "tool") return parts;
  const who = speakers[message.role];
  const footer = usage === undefined ? "" : usageHtml(usage, rendering.modelId);
  return [
    `<article class="entry ${message.role}" id="e-${text(id)}">`,
    `<header><span class="glyph">${who.glyph}</span> ${who.name}`,
    ` <time>${text(stamp(timestamp))}</time>${label}</header>`,
    parts,
    footer,
    "</article>",
  ].join("");
}

const speakers = {
  user: { glyph: glyphs.user, name: "you" },
  assistant: { glyph: glyphs.agent, name: "assistant" },
  system: { glyph: glyphs.agent, name: "system" },
  tool: { glyph: glyphs.agent, name: "tool" },
} as const;

function partHtml(part: Part, rendering: Rendering): string {
  switch (part.type) {
    case "text":
      return part.text.trim() === "" ? "" : `<div class="prose">${text(part.text)}</div>`;
    case "thinking":
      return thinkingHtml(part.thinking);
    case "visible-thinking":
      return thinkingHtml(part.text);
    case "redacted-thinking":
      return '<p class="note">thinking sealed by the provider</p>';
    case "image":
      return imageHtml(part.mediaType, part.data);
    case "tool-call":
      return toolHtml(part, rendering.results.get(part.callId));
    case "tool-result":
      return rendering.results.get(part.callId) === part ? "" : orphanResultHtml(part);
  }
}

function thinkingHtml(thought: string): string {
  if (thought.trim() === "") return "";
  return `<details class="thinking"><summary>thinking</summary><div class="prose">${text(thought)}</div></details>`;
}

function toolHtml(call: ToolCallPart, result: ToolResultPart | undefined): string {
  const failed = result?.isError === true ? " failed" : "";
  const status = result === undefined ? "no result" : result.isError ? "failed" : "ok";
  return [
    `<details class="tool${failed}">`,
    `<summary><span class="glyph">${toolGlyph(call.name)}</span> <b>${text(call.name)}</b>`,
    ` <code>${text(compactJson(call.arguments, 96))}</code>`,
    ` <span class="status">${status}</span></summary>`,
    `<pre class="arguments">${text(JSON.stringify(call.arguments, null, 2) ?? "")}</pre>`,
    result === undefined ? "" : outputHtml(result),
    "</details>",
  ].join("");
}

function orphanResultHtml(result: ToolResultPart): string {
  const failed = result.isError ? " failed" : "";
  return [
    `<details class="tool${failed}">`,
    `<summary><span class="glyph">${glyphs.agent}</span> <b>result</b>`,
    ` <code>${text(result.callId)}</code></summary>`,
    outputHtml(result),
    "</details>",
  ].join("");
}

function outputHtml(result: ToolResultPart): string {
  const spill =
    result.spill === undefined
      ? ""
      : `<p class="note">${result.spill.bytes.toLocaleString("en-US")} bytes of this output were kept beside the session file</p>`;
  return `<pre class="output">${text(result.output)}</pre>${spill}`;
}

function toolGlyph(name: string): string {
  return name.includes("__") ? glyphs.external : glyphs.agent;
}

function imageHtml(mediaType: string, data: string): string {
  if (!safeImageType.test(mediaType) || !base64.test(data)) {
    return `<p class="note">image (${text(mediaType)}) left out</p>`;
  }
  return `<img alt="attached image" src="data:${mediaType};base64,${data}">`;
}

const safeImageType = /^image\/(?:png|jpeg|gif|webp)$/;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function usageHtml(usage: Usage, modelId: string | undefined): string {
  const nanos = costNanosOf(usage, modelId);
  const cost = nanos === undefined ? "unpriced" : formatCostNanos(nanos);
  const cached = usage.cacheReadInputTokens ?? 0;
  const tokens = [
    `${usage.inputTokens.toLocaleString("en-US")} in`,
    `${usage.outputTokens.toLocaleString("en-US")} out`,
    ...(cached > 0 ? [`${cached.toLocaleString("en-US")} cached`] : []),
  ];
  return `<footer class="usage">${tokens.join(" · ")} · ${cost}</footer>`;
}

function foldHtml(heading: string, summary: string, label: string): string {
  return [
    `<aside class="fold"><p>${text(heading)}${label}</p>`,
    `<details><summary>summary</summary><div class="prose">${text(summary)}</div></details>`,
    "</aside>",
  ].join("");
}

function markerHtml(words: string, label: string): string {
  return `<p class="marker">${text(words)}${label}</p>`;
}

function labelPill(label: string | undefined): string {
  return label === undefined ? "" : ` <span class="label">${text(label)}</span>`;
}

function resultsByCallId(entries: readonly SessionEntry[]): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>();
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const part of entry.message.parts) {
      if (part.type === "tool-call") calls.add(part.callId);
      if (part.type === "tool-result" && calls.has(part.callId)) results.set(part.callId, part);
    }
  }
  return results;
}

function flatten(roots: readonly SessionTreeNode[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const pending = [...roots].reverse();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    entries.push(node.entry);
    pending.push(...[...node.children].reverse());
  }
  return entries;
}

function stamp(iso: string): string {
  return iso === "" ? "unknown time" : iso.slice(0, 16).replace("T", " ");
}

function text(raw: string): string {
  return raw
    .replace(markup, (character) => escapes[character] ?? character)
    .replace(
      hiddenCharacters,
      (character) => `<span class="hidden-char">U+${codePointOf(character)}</span>`,
    );
}

const markup = /[&<>"']/g;
const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const hiddenCharacters =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

function codePointOf(character: string): string {
  return (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
}

const contentPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const stylesheet = `
:root { color-scheme: light dark; --line: color-mix(in srgb, CanvasText 18%, Canvas); --soft: color-mix(in srgb, CanvasText 5%, Canvas); --muted: color-mix(in srgb, CanvasText 60%, Canvas); }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1rem 4rem; background: Canvas; color: CanvasText; font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
.masthead { border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; padding-bottom: 1rem; }
.masthead dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: 0; font-size: .85rem; }
.masthead dt { color: var(--muted); }
.masthead dd { margin: 0; overflow-wrap: anywhere; }
.entry { border-left: 3px solid var(--line); margin: 1.25rem 0; padding: .25rem 0 .25rem .9rem; }
.entry.user { border-left-color: CanvasText; }
.entry > header { color: var(--muted); font-size: .8rem; margin-bottom: .35rem; }
.glyph { font-family: ui-monospace, monospace; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; }
pre, code { font: .82rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--soft); border-radius: 4px; margin: .4rem 0; max-height: 32rem; overflow: auto; padding: .6rem .75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
details { margin: .4rem 0; }
summary { cursor: pointer; }
.tool { border: 1px solid var(--line); border-radius: 4px; padding: .3rem .6rem; }
.tool summary code { color: var(--muted); }
.tool .status { color: var(--muted); float: right; font-size: .8rem; }
.tool.failed { border-color: color-mix(in srgb, #c33 60%, var(--line)); }
.tool.failed .status { color: #c33; }
.thinking summary, .fold summary { color: var(--muted); font-size: .85rem; }
.thinking .prose { color: var(--muted); }
.fold { border: 1px dashed var(--line); border-radius: 4px; margin: 1.25rem 0; padding: .5rem .75rem; }
.fold p { margin: 0; }
.marker, .note, .usage { color: var(--muted); font-size: .8rem; }
.marker { margin: .6rem 0; }
.marker::before { content: "· "; }
.label { border: 1px solid var(--line); border-radius: 999px; font-size: .75rem; padding: 0 .45rem; }
.fork { border-left: 1px dotted var(--line); margin: 1rem 0; padding-left: .75rem; }
.branch { margin: .75rem 0; opacity: .8; }
.branch.active { opacity: 1; }
.branch-head { font-size: .8rem; font-weight: 600; margin: 0; }
.hidden-char { border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font: .7rem ui-monospace, monospace; padding: 0 .2rem; }
img { max-width: 100%; }
`.trim();
