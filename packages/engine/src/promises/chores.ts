import { isoOf } from "../routines/clock.ts";
import type { RunRow } from "../routines/run.ts";
import type { ChoreJournal } from "../routines/service.ts";
import { stateOf } from "./state.ts";
import type { CreaturePromise, PromiseEvidence, RepairEpisode } from "./types.ts";

export interface StoppedChore {
  routineId: string;
  title: string;
  reason: string;
  since: string;
  byCheck: boolean;
}

export const choresRanChecks =
  "Each chore that is on ran when it was due and finished, or its check found nothing to do. A chore that fails is tried again on its own, a few times; a chore that still fails stops and asks you what to do.";

export function choresRan(journals: readonly ChoreJournal[], bound: number): CreaturePromise {
  const watched = journals.filter(isWatched);
  const evidence = watched.map(evidenceOf);
  const repairs = watched.flatMap((journal) => repairOf(journal, bound) ?? []);
  return {
    kind: "chores-ran",
    state: stateOf(evidence, repairs),
    checks: choresRanChecks,
    evidence,
    repairs,
  };
}

export function stoppedChores(journals: readonly ChoreJournal[]): StoppedChore[] {
  return journals.flatMap(({ view }) => {
    const disabled = view.schedule.disabled;
    if (disabled === null || view.routine === null) return [];
    return [
      {
        routineId: view.id,
        title: view.routine.title,
        reason: lastReasonOf(disabled.reason),
        since: disabled.at,
        byCheck: lastReasonOf(disabled.reason).startsWith("its check"),
      },
    ];
  });
}

function isWatched({ view }: ChoreJournal): boolean {
  return view.routine !== null && (view.schedule.enabled || view.schedule.disabled !== null);
}

function evidenceOf(journal: ChoreJournal): PromiseEvidence {
  const { view } = journal;
  const subject = view.routine?.title ?? view.id;
  const disabled = view.schedule.disabled;
  if (disabled !== null) {
    return {
      subject,
      checkedAt: disabled.at,
      found: `stopped after it kept failing: ${lastReasonOf(disabled.reason)}`,
      ok: false,
    };
  }
  const run = lastRealRun(journal.runs);
  const check = view.lastCheck;
  const ranAt = run?.endedAt ?? null;
  const checkIsNewer = check !== null && (ranAt === null || check.at > ranAt);
  if (check !== null && checkIsNewer && check.verdict === "quiet") {
    return { subject, checkedAt: check.at, found: `its check ${check.found}`, ok: true };
  }
  if (run === undefined) {
    return {
      subject,
      checkedAt: null,
      found:
        view.schedule.nextRunAt === null ? "has not run yet" : "has not run yet; it is due later",
      ok: null,
    };
  }
  return {
    subject,
    checkedAt: run.endedAt ?? run.startedAt,
    ...runFinding(run, view.schedule.retryAt),
  };
}

function runFinding(run: RunRow, retryAt: string | null): Pick<PromiseEvidence, "found" | "ok"> {
  if (run.status === "running" || run.status === "parked") {
    return {
      found: run.status === "parked" ? `waits: ${run.reason ?? "on you"}` : "is running now",
      ok: null,
    };
  }
  switch (run.process) {
    case "completed":
      return run.delivery === "failed" || run.delivery === "unknown"
        ? {
            found: `ran, but what it made was not delivered: ${run.reason ?? run.delivery}`,
            ok: false,
          }
        : {
            found: run.delivery === "delivered" ? "ran and delivered" : "ran and finished",
            ok: true,
          };
    case "failed":
    case "timed-out":
      return {
        found: `failed: ${run.reason ?? run.process}${retryAt === null ? "" : "; trying again"}`,
        ok: false,
      };
    case "blocked":
      return { found: `stopped: ${run.reason ?? "over its budget"}`, ok: false };
    case "cancelled":
      return { found: "was stopped", ok: null };
    default:
      return { found: "has no ending recorded", ok: null };
  }
}

function repairOf(journal: ChoreJournal, bound: number): RepairEpisode | undefined {
  const { view } = journal;
  const subject = view.routine?.title ?? view.id;
  const scheduled = journal.runs.filter(
    (run) => run.trigger !== "manual" && run.status !== "skipped" && run.status !== "dropped",
  );
  const [newest] = scheduled;
  if (newest === undefined) return undefined;
  const leading = failedStreak(scheduled);
  if (view.schedule.disabled !== null && leading.length > 0) {
    return episode(subject, leading, bound, null, view.schedule.disabled.at, "failed");
  }
  if (leading.length > 0 && view.schedule.retryAt !== null) {
    return episode(subject, leading, bound, view.schedule.retryAt, null, "repairing");
  }
  const check = view.lastCheck;
  if (leading.length > 0 && check !== null && check.verdict === "quiet") {
    return episode(subject, leading, bound, null, check.at, "repaired");
  }
  if (newest.process !== "completed") return undefined;
  const before = failedStreak(scheduled.slice(1));
  if (before.length === 0) return undefined;
  const repaired = episode(subject, before, bound, null, newest.endedAt, "repaired");
  return { ...repaired, tries: before.length + 1 };
}

function episode(
  subject: string,
  failures: readonly RunRow[],
  bound: number,
  nextAt: string | null,
  endedAt: string | null,
  outcome: RepairEpisode["outcome"],
): RepairEpisode {
  const first = failures.at(-1);
  return {
    subject,
    startedAt: first?.endedAt ?? first?.firedAt ?? isoOf(0),
    tries: failures.length,
    bound,
    nextAt,
    endedAt,
    outcome,
  };
}

function failedStreak(runs: readonly RunRow[]): RunRow[] {
  const streak: RunRow[] = [];
  for (const run of runs) {
    if (run.status !== "ended" || (run.process !== "failed" && run.process !== "timed-out")) break;
    streak.push(run);
  }
  return streak;
}

function lastRealRun(runs: readonly RunRow[]): RunRow | undefined {
  return runs.find((run) => run.status !== "skipped" && run.status !== "dropped");
}

export function lastReasonOf(disabledReason: string): string {
  const marker = "; the last: ";
  const at = disabledReason.indexOf(marker);
  if (at >= 0) return disabledReason.slice(at + marker.length);
  const asked = "the try you asked for failed too: ";
  return disabledReason.startsWith(asked) ? disabledReason.slice(asked.length) : disabledReason;
}
