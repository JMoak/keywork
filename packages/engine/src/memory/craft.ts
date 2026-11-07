import type { Note } from "./notes.ts";
import type { MemoryStore, WriteResult } from "./store.ts";

export const craftSection = "craft";

export interface CraftLesson {
  title: string;
  body: string;
  session?: string;
}

export function isCraftNote(note: Note): boolean {
  return note.frontmatter.section === craftSection;
}

export async function craftNotes(store: Pick<MemoryStore, "listNotes">): Promise<Note[]> {
  return (await store.listNotes()).filter(isCraftNote);
}

export function learnCraft(
  store: Pick<MemoryStore, "writeNote">,
  creature: string,
  lesson: CraftLesson,
): Promise<WriteResult> {
  return store.writeNote({
    title: lesson.title,
    body: lesson.body,
    provenance: "agent",
    origin: { kind: "craft", id: creature },
    ...(lesson.session !== undefined && { session: lesson.session }),
  });
}
