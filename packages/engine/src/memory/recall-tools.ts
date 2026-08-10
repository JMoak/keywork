import { z } from "zod";
import { defineTool } from "../tools/define.ts";
import type { Tool } from "../tools.ts";
import { type MemorySearch, type SearchHit, tokenize } from "./search.ts";
import type { DailyEntry, MemoryStore, Note } from "./store.ts";

export type RecallListener = (noteName: string) => void;

export function memoryRecallTools(
  store: MemoryStore,
  search: MemorySearch,
  onRecall?: RecallListener,
): Tool[] {
  return [memorySearchTool(store, search, onRecall), memoryGetTool(store)];
}

export function memorySearchTool(
  store: MemoryStore,
  search: MemorySearch,
  onRecall?: RecallListener,
): Tool {
  return defineTool({
    name: "memory_search",
    description:
      "Search the memory vault (atomic notes and daily logs) for remembered facts, decisions, and conventions. Read a full note afterwards with memory_get.",
    schema: searchSchema,
    run: async ({ query, limit }) => {
      const outcome = await search.search(query, { limit });
      const daily = await searchDaily(store, query, limit);
      if (outcome.hits.length === 0 && daily.length === 0) {
        return `no memories match ${JSON.stringify(query)}`;
      }
      for (const hit of outcome.hits) onRecall?.(hit.note.name);
      return renderSearch(outcome.hits, daily, outcome.source.kind);
    },
  });
}

export function memoryGetTool(store: MemoryStore): Tool {
  return defineTool({
    name: "memory_get",
    description:
      "Read a memory note (or a daily log by date, e.g. daily/2026-08-10) by name, returning numbered lines. Use offset and limit to read a range after a memory_search hit.",
    schema: getSchema,
    run: async ({ note, offset, limit }) => {
      const date = dailyDate(note);
      if (date !== undefined) return renderDaily(store, date, offset, limit);
      const found = await store.readNote(note);
      if (found === undefined) return `no note named ${JSON.stringify(note)}`;
      return renderNote(found, offset, limit);
    },
  });
}

const searchSchema = z.object({
  query: z.string().min(1).describe("What to look for; plain words work best."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe("Maximum results per section (notes and daily entries)."),
});

const getSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe("Note name from a memory_search hit, or a daily log date (YYYY-MM-DD)."),
  offset: z.number().int().min(1).default(1).describe("First line to read (1-based)."),
  limit: z.number().int().min(1).default(200).describe("Maximum number of lines to return."),
});

const snippetLength = 120;

interface DailyHit {
  date: string;
  entry: DailyEntry;
  matches: number;
}

async function searchDaily(store: MemoryStore, query: string, limit: number): Promise<DailyHit[]> {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return [];
  const hits: DailyHit[] = [];
  for (const date of await store.listDailyDates()) {
    for (const entry of await store.readDaily(date)) {
      const entryTerms = new Set(tokenize(entry.text));
      const matches = [...terms].filter((term) => entryTerms.has(term)).length;
      if (matches > 0) hits.push({ date, entry, matches });
    }
  }
  return hits
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        b.date.localeCompare(a.date) ||
        b.entry.time.localeCompare(a.entry.time),
    )
    .slice(0, limit);
}

function renderSearch(hits: SearchHit[], daily: DailyHit[], retrieval: string): string {
  const sections: string[] = [];
  if (hits.length > 0) sections.push(`notes:\n${hits.map(renderHit).join("\n")}`);
  if (daily.length > 0) sections.push(`daily:\n${daily.map(renderDailyHit).join("\n")}`);
  sections.push(`retrieval: ${retrieval}`);
  return sections.join("\n");
}

function renderHit(hit: SearchHit, index: number): string {
  const line = `${index + 1}. [[${hit.note.name}]] — ${snippet(hit.note.body)}`;
  return hit.note.supersededBy === undefined
    ? line
    : `${line}\n   superseded by [[${hit.note.supersededBy}]]`;
}

function renderDailyHit(hit: DailyHit): string {
  return `- daily/${hit.date} ${hit.entry.time} [${hit.entry.provenance}] ${snippet(hit.entry.text)}`;
}

function snippet(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > snippetLength ? `${line.slice(0, snippetLength)}…` : line;
}

async function renderDaily(
  store: MemoryStore,
  date: string,
  offset: number,
  limit: number,
): Promise<string> {
  const entries = await store.readDaily(date);
  if (entries.length === 0) return `no daily log for ${date}`;
  const lines = entries.flatMap((entry) =>
    `${entry.time} [${entry.provenance}] ${entry.text}`.split("\n"),
  );
  return numberedRange(`daily/${date}`, lines, offset, limit);
}

function renderNote(note: Note, offset: number, limit: number): string {
  const header = [
    `[[${note.name}]]`,
    `provenance: ${note.provenance}`,
    ...(note.pinned ? ["pinned"] : []),
    ...(note.supersededBy === undefined ? [] : [`superseded by [[${note.supersededBy}]]`]),
  ].join(" · ");
  const body = numberedRange(note.name, note.body.replace(/\n$/, "").split("\n"), offset, limit);
  return `${header}\n${body}`;
}

function numberedRange(name: string, lines: string[], offset: number, limit: number): string {
  if (offset > lines.length) {
    return `${JSON.stringify(name)} has only ${lines.length} line${lines.length === 1 ? "" : "s"}`;
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((line, index) => `${String(offset + index).padStart(5)}\t${line}`)
    .join("\n");
  const remaining = lines.length - (offset - 1 + slice.length);
  return remaining > 0 ? `${numbered}\n... (${remaining} more lines)` : numbered;
}

function dailyDate(note: string): string | undefined {
  const match = note.match(/^(?:daily\/)?(\d{4}-\d{2}-\d{2})$/);
  return match?.[1];
}
