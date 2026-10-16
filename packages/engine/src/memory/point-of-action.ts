import type { ToolCallPart } from "../messages.ts";
import type { ContextBudget } from "../session/context-budget.ts";
import { searchHitLayer } from "./arcs/recall.ts";
import { builtinDecider } from "./builtin-decider.ts";
import type { RecallTap } from "./citations.ts";
import {
  type ActionBudget,
  type DecisionSink,
  type MemoryDecider,
  type PendingAction,
  recorded,
} from "./decider.ts";
import { neutralizeRecalled } from "./neutralize.ts";
import type { MemorySearcher, SearchHit, SearchOutcome } from "./search.ts";

export type ActionRecall = (call: ToolCallPart) => Promise<string | undefined>;

export interface ActionRecallOptions {
  search: MemorySearcher;
  tokens?: number;
  milliseconds?: number;
  notes?: number;
  tap?: RecallTap;
  onRecall?: (noteName: string) => void;
  decider?: MemoryDecider;
  onDecision?: DecisionSink;
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
  const budget: ActionBudget = {
    tokens: options.tokens ?? actionRecallDefaults.tokens,
    notes: options.notes ?? actionRecallDefaults.notes,
  };
  const milliseconds = options.milliseconds ?? actionRecallDefaults.milliseconds;
  const decider = options.decider ?? builtinDecider();
  const surfacedSubjects = new Set<string>();
  const surfacedNotes = new Set<string>();
  return async (call) => {
    try {
      const action = pendingAction(call);
      if (action === undefined || budget.tokens <= 0 || surfacedSubjects.has(action.subject))
        return undefined;
      surfacedSubjects.add(action.subject);
      const outcome = await boundedSearch(
        options.search,
        action.subject,
        budget.notes,
        milliseconds,
      );
      if (outcome === undefined || outcome.hits.length === 0) return undefined;
      const chosen = recorded(
        await decider.chooseForAction({
          action,
          hits: outcome.hits,
          surfaced: surfacedNotes,
          budget,
        }),
        options.onDecision,
      );
      if (chosen.length === 0) return undefined;
      for (const hit of chosen) {
        surfacedNotes.add(hit.note.name);
        options.onRecall?.(hit.note.name);
        options.tap?.recordRecall(hit.note.name, "action", searchHitLayer(hit));
      }
      return renderActionRecall(action.subject, chosen, outcome.source.kind);
    } catch {
      return undefined;
    }
  };
}

export function actionSubject(call: ToolCallPart): string | undefined {
  return pendingAction(call)?.subject;
}

export function pendingAction(call: ToolCallPart): PendingAction | undefined {
  const subjectKind = subjectKinds[call.name];
  if (subjectKind === undefined) return undefined;
  const args = call.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[subjectKind];
  if (typeof value !== "string") return undefined;
  const line = value.split("\n", 1)[0]?.trim() ?? "";
  if (line === "") return undefined;
  return { callId: call.callId, tool: call.name, subject: line.slice(0, subjectCap), subjectKind };
}

const subjectKinds: Readonly<Record<string, PendingAction["subjectKind"]>> = {
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

function renderActionRecall(
  subject: string,
  hits: readonly SearchHit[],
  retrieval: string,
): string {
  const sections = hits.map(
    (hit) => `### [[${hit.note.name}]]\n\n${neutralizeRecalled(hit.note.body.trim())}\n`,
  );
  return [`## memory for ${subject}`, "", ...sections, `retrieval: ${retrieval}`].join("\n");
}
