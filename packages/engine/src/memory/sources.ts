import { isCraftNote } from "./craft.ts";
import type { Frontmatter } from "./frontmatter.ts";
import { titleKey } from "./naming.ts";
import { firstString, type Note } from "./notes.ts";

export const memorySourceKinds = ["session", "creature", "web", "workshop", "craft"] as const;
export type MemorySourceKind = (typeof memorySourceKinds)[number];

export interface MemorySource {
  kind: MemorySourceKind;
  id: string;
  note?: string;
}

export class InvalidMemorySourceError extends Error {
  constructor(readonly text: string) {
    super(
      `invalid memory source ${JSON.stringify(text)}: expected ${memorySourceKinds.join("|")}:<id>`,
    );
    this.name = "InvalidMemorySourceError";
  }
}

export function parseMemorySource(text: string): MemorySource {
  const divide = text.indexOf(":");
  const kind = text.slice(0, divide);
  const rest = text.slice(divide + 1).trim();
  if (divide <= 0 || !isMemorySourceKind(kind) || rest === "")
    throw new InvalidMemorySourceError(text);
  if (kind !== "craft") return { kind, id: rest };
  const slash = rest.indexOf("/");
  if (slash === -1) return { kind, id: rest };
  const id = rest.slice(0, slash);
  const note = rest.slice(slash + 1).trim();
  if (id === "" || note === "") throw new InvalidMemorySourceError(text);
  return { kind, id, note };
}

export function sourceText(source: MemorySource): string {
  const head = `${source.kind}:${source.id}`;
  return source.note === undefined ? head : `${head}/${source.note}`;
}

export function originFrontmatter(inherited: Frontmatter, source: MemorySource): Frontmatter {
  switch (source.kind) {
    case "session":
      return {};
    case "craft":
      return { section: "craft" };
    case "creature":
      return firstOrigin(inherited, {
        origin_source: sourceText(source),
        origin_creature: source.id,
      });
    case "web":
    case "workshop":
      return firstOrigin(inherited, { origin_source: sourceText(source) });
  }
}

export function noteFromSource(note: Note, source: MemorySource): boolean {
  switch (source.kind) {
    case "session":
      return note.originSession === source.id;
    case "creature":
      return firstString(note.frontmatter.origin_creature) === source.id;
    case "web":
    case "workshop":
      return firstString(note.frontmatter.origin_source) === sourceText(source);
    case "craft":
      return isCraftNote(note) && (source.note === undefined || sameNote(note, source.note));
  }
}

function isMemorySourceKind(kind: string): kind is MemorySourceKind {
  return (memorySourceKinds as readonly string[]).includes(kind);
}

function firstOrigin(inherited: Frontmatter, origin: Frontmatter): Frontmatter {
  return firstString(inherited.origin_source) === undefined ? origin : {};
}

function sameNote(note: Note, name: string): boolean {
  return titleKey(note.name) === titleKey(name) || titleKey(note.title) === titleKey(name);
}
