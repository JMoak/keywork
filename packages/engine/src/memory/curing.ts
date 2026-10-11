import type { Note } from "./notes.ts";

export type CuringStage = 0 | 1 | 2 | 3;

export const settledUsefulness = 0.5;

export function curingStage(note: Note): CuringStage {
  if (note.provenance === "user" || note.pinned) return 3;
  const usefulness = note.usefulness ?? 0;
  if (usefulness >= settledUsefulness) return 3;
  if (usefulness > 0) return 2;
  return note.confidence === undefined ? 0 : 1;
}
