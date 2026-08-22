import { Text, type TextChunk } from "@opentui/core";
import type { Theme } from "./theme.ts";

export function clipChunks(chunks: readonly TextChunk[], width: number): TextChunk[] {
  const clipped: TextChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const points = Array.from(chunk.text);
    const room = width - used;
    if (room <= 0) break;
    const text = points.length <= room ? chunk.text : points.slice(0, room).join("");
    clipped.push({ ...chunk, text });
    used += Math.min(points.length, room);
  }
  return clipped;
}

export function dimLine(text: string, theme: Theme, width: number) {
  return Text({ content: [...text].slice(0, width).join(""), fg: theme.textDim });
}
