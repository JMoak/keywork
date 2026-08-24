import { bg, bold, fg, italic, type TextChunk, underline } from "@opentui/core";
import type { MarkdownSpan, MarkdownTone } from "./markdown.ts";
import type { Theme } from "./theme.ts";

export function markdownChunk(span: MarkdownSpan, theme: Theme, panel: boolean): TextChunk {
  let chunk = fg(markdownInk(span.tone, theme))(span.text);
  if (span.bold === true) chunk = bold(chunk);
  if (span.italic === true) chunk = italic(chunk);
  if (span.tone === "link") chunk = underline(chunk);
  if (span.tone === "code") chunk = bg(theme.panelLift)(chunk);
  if (panel) chunk = bg(theme.panel)(chunk);
  return chunk;
}

export function markdownInk(tone: MarkdownTone, theme: Theme): string {
  switch (tone) {
    case "body":
    case "code":
    case "fence":
      return theme.text;
    case "link":
    case "heading":
    case "headingMark":
    case "listMarker":
      return theme.accent;
    case "linkUrl":
      return theme.textMid;
    case "fenceRail":
      return theme.accentSoft;
    case "rule":
    case "fenceTag":
      return theme.textDim;
    case "meta":
      return theme.textMid;
    case "ok":
    case "added":
    case "string":
      return theme.success;
    case "bad":
    case "removed":
      return theme.error;
    case "keyword":
      return rampStop(theme, 0);
    case "type":
      return rampStop(theme, 1);
    case "constant":
      return rampStop(theme, 2);
    case "comment":
    case "hunk":
      return theme.textDim;
    case "punctuation":
      return theme.textMid;
  }
}

function rampStop(theme: Theme, stop: number): string {
  return theme.ramp[Math.min(stop, theme.ramp.length - 1)] ?? theme.accent;
}
