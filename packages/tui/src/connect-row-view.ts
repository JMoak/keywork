import { fg, StyledText, Text } from "@opentui/core";
import type { ConnectRow, ConnectTone } from "./connect-model.ts";
import type { Palette } from "./palette.ts";
import { clipSpans, wrapPhrases } from "./width.ts";

export function connectRowView(row: ConnectRow, theme: Palette, room: number) {
  const chunks = row.spans.map((part) =>
    fg(row.selected ? theme.accent : connectToneInk(part.tone, theme))(part.text),
  );
  return Text({ content: new StyledText(clipSpans(chunks, room)) });
}

export function connectRowLines(row: ConnectRow, theme: Palette, room: number) {
  const [only, ...more] = row.spans;
  if (row.selected || only === undefined || more.length > 0) {
    return [connectRowView(row, theme, room)];
  }
  const ink = connectToneInk(only.tone, theme);
  return wrapPhrases(only.text, room).map((line) => Text({ content: line, fg: ink }));
}

export function connectToneInk(tone: ConnectTone, theme: Palette): string {
  switch (tone) {
    case "text":
      return theme.text;
    case "dim":
      return theme.textDim;
    case "accent":
      return theme.accent;
    case "danger":
      return theme.error;
  }
}
