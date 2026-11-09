export const settingKinds = ["file", "diff", "report", "thread", "chore", "url", "note"] as const;

export type SettingKind = (typeof settingKinds)[number];

export const rungs = ["lantern", "card", "unfold", "stage"] as const;

export type Rung = (typeof rungs)[number];

export const settingAnswers = ["seen", "pinned", "unpinned", "dismissed"] as const;

export type SettingAnswer = (typeof settingAnswers)[number];

export type SettledOutcome = SettingAnswer | "withdrawn";

export type SettledBy = "keeper" | "creature" | "time";

export type SettingState = "live" | "seen" | "pinned" | "dismissed" | "withdrawn";

export const settingOrigins = ["creature", "keeper"] as const;

export type SettingOrigin = (typeof settingOrigins)[number];

export type SettingUntil = "seen" | "rests" | string;

export interface SettingWhat {
  kind: SettingKind;
  ref: string;
  title?: string;
}

export interface Setting {
  id: string;
  creature: string | null;
  sessionId: string;
  what: SettingWhat;
  rung: Rung;
  why: string;
  at: string;
  until: SettingUntil;
  state: SettingState;
  from: string | null;
  origin: SettingOrigin;
  replaces: string | null;
}

export interface ShowProposed {
  setting: Setting;
}

export interface ShowSettled {
  id: string;
  outcome: SettledOutcome;
  by: SettledBy;
}

export interface ShowEvents {
  "show.proposed": ShowProposed;
  "show.settled": ShowSettled;
}

export type ShowEventType = keyof ShowEvents;

export type ShowEventSink = <Type extends ShowEventType>(
  sessionId: string,
  type: Type,
  payload: ShowEvents[Type],
) => void;
