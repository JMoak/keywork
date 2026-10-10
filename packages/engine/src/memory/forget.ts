import type { Note } from "./notes.ts";
import type { StagedReview } from "./staging.ts";
import type { MemoryStore } from "./store.ts";

export interface ForgetEntry {
  id: string;
  date: string;
  time: string;
  text: string;
}

export interface ForgetRefusal {
  note: string;
  reason: string;
}

export interface ForgetPlan {
  session: string;
  notes: string[];
  entries: ForgetEntry[];
  refused: ForgetRefusal[];
}

export async function planForget(store: MemoryStore, session: string): Promise<ForgetPlan> {
  const plan: ForgetPlan = { session, notes: [], entries: [], refused: [] };
  for (const note of await store.listNotes()) {
    const refusal = refusalFor(note, session);
    if (refusal !== undefined) plan.refused.push({ note: note.name, reason: refusal });
    else if (note.originSession === session) plan.notes.push(note.name);
  }
  for (const date of await store.listDailyDates()) {
    (await store.readDaily(date)).forEach((entry, index) => {
      if (entry.session === session)
        plan.entries.push({ id: `${date}#${index}`, date, time: entry.time, text: entry.text });
    });
  }
  return plan;
}

export function isEmptyPlan(plan: ForgetPlan): boolean {
  return plan.notes.length === 0 && plan.entries.length === 0;
}

export async function stageForget(
  store: Pick<MemoryStore, "propose">,
  plan: ForgetPlan,
): Promise<StagedReview | undefined> {
  if (isEmptyPlan(plan)) return undefined;
  const [review] = await store.propose([
    {
      kind: "forget-proposal",
      session: plan.session,
      notes: plan.notes,
      entries: plan.entries.map((entry) => entry.id),
    },
  ]);
  return review;
}

function refusalFor(note: Note, session: string): string | undefined {
  const revisedBy = note.revisedBy ?? [];
  if (note.originSession === session && revisedBy.length > 0)
    return `also revised by ${describeSessions(revisedBy)}; mixed provenance, kept`;
  if (note.originSession !== session && revisedBy.includes(session))
    return `originated in ${note.originSession ?? "an unknown session"}; this session only revised it, kept`;
  return undefined;
}

function describeSessions(sessions: readonly string[]): string {
  return sessions.length === 1 ? `session ${sessions[0]}` : `sessions ${sessions.join(", ")}`;
}
