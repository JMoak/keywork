import type { ToolCallPart } from "../messages.ts";
import type { ContextBudget } from "../session/context-budget.ts";
import { searchHitLayer } from "./arcs/recall.ts";
import type { RecallTap } from "./citations.ts";
import type { MemorySearcher, SearchHit, SearchOutcome } from "./search.ts";

export type ActionRecall = (call: ToolCallPart) => Promise<string | undefined>;

export interface ActionRecallOptions {
  search: MemorySearcher;
  tokens?: number;
  milliseconds?: number;
  notes?: number;
  tap?: RecallTap;
  onRecall?: (noteName: string) => void;
}

export const actionRecallDefaults = {
  tokens: 1024,
  milliseconds: 150,
  notes: 3,
} as const;

export function actionRecallBudget(budget: ContextBudget): number {
  return Math.min(actionRecallDefaults.tokens, Math.floor(budget.flushReserve / 8));
}

export function pointOfActionRecall(options: ActionRecallOptions): ActionRecall {
  const tokens = options.tokens ?? actionRecallDefaults.tokens;
  const milliseconds = options.milliseconds ?? actionRecallDefaults.milliseconds;
  const notes = options.notes ?? actionRecallDefaults.notes;
  const surfacedSubjects = new Set<string>();
  const surfacedNotes = new Set<string>();
  return async (call) => {
    try {
      const subject = actionSubject(call);
      if (subject === undefined || tokens <= 0 || surfacedSubjects.has(subject)) return undefined;
      surfacedSubjects.add(subject);
      const outcome = await boundedSearch(options.search, subject, notes, milliseconds);
      if (outcome === undefined) return undefined;
      const chosen = selectRelevant(outcome.hits, surfacedNotes, tokens, notes);
      if (chosen.length === 0) return undefined;
      for (const hit of chosen) {
        surfacedNotes.add(hit.note.name);
        options.onRecall?.(hit.note.name);
        options.tap?.recordRecall(hit.note.name, "action", searchHitLayer(hit));
      }
      return renderActionRecall(subject, chosen, outcome.source.kind);
    } catch {
      return undefined;
    }
  };
}

export function actionSubject(call: ToolCallPart): string | undefined {
  const key = subjectKeys[call.name];
  if (key === undefined) return undefined;
  const args = call.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const line = value.split("\n", 1)[0]?.trim() ?? "";
  return line === "" ? undefined : line.slice(0, subjectCap);
}

const subjectKeys: Readonly<Record<string, string>> = {
  write: "path",
  edit: "path",
  bash: "command",
};

const subjectCap = 200;

async function boundedSearch(
  search: MemorySearcher,
  subject: string,
  limit: number,
  milliseconds: number,
): Promise<SearchOutcome | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), milliseconds);
  });
  const searching = search.search(subject, { limit }).then(
    (outcome) => outcome,
    () => undefined,
  );
  try {
    return await Promise.race([searching, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function selectRelevant(
  hits: readonly SearchHit[],
  alreadySurfaced: ReadonlySet<string>,
  tokenBudget: number,
  noteCap: number,
): SearchHit[] {
  const chosen: SearchHit[] = [];
  let spent = 0;
  for (const hit of hits) {
    if (chosen.length >= noteCap) break;
    if (hit.superseded || alreadySurfaced.has(hit.note.name)) continue;
    if (hit.ranks.lexical === undefined && hit.ranks.semantic === undefined) continue;
    if (spent + hit.note.tokens > tokenBudget) continue;
    chosen.push(hit);
    spent += hit.note.tokens;
  }
  return chosen;
}

function renderActionRecall(
  subject: string,
  hits: readonly SearchHit[],
  retrieval: string,
): string {
  const sections = hits.map((hit) => `### [[${hit.note.name}]]\n\n${hit.note.body.trim()}\n`);
  return [`## memory for ${subject}`, "", ...sections, `retrieval: ${retrieval}`].join("\n");
}
