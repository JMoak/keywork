import type { CheckResult } from "./check.ts";
import type { RunRow, RunTrigger } from "./run.ts";
import type { NeedsYouItem } from "./service.ts";

export interface RoutineFired {
  runId: string;
  creature: string;
  routineId: string;
  attempt: number;
  trigger: RunTrigger;
  catchUp: boolean;
  firedAt: string;
  scheduledFor: string;
  startedAt: string;
  sessionId: string;
}

export interface RoutineFinished {
  run: RunRow;
  disabled: string | null;
}

export interface RoutineNeedsYou {
  creature: string;
  routineId: string;
  items: NeedsYouItem[];
}

export interface RoutineChecked {
  creature: string;
  routineId: string;
  check: CheckResult;
}

export interface RoutineEvents {
  "routine.fired": RoutineFired;
  "routine.finished": RoutineFinished;
  "routine.needs": RoutineNeedsYou;
  "routine.checked": RoutineChecked;
}

export type RoutineEventType = keyof RoutineEvents;

export const routineEventTypes = [
  "routine.fired",
  "routine.finished",
  "routine.needs",
  "routine.checked",
] as const satisfies readonly RoutineEventType[];

export type RoutineEventSink = <Type extends RoutineEventType>(
  type: Type,
  payload: RoutineEvents[Type],
) => void;

export const silentSink: RoutineEventSink = () => {};
