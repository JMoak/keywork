import type { ShowArranged } from "./arrangement.ts";
import type { Seat } from "./seat.ts";

export const settingKinds = [
  "file",
  "diff",
  "report",
  "thread",
  "chore",
  "url",
  "note",
  "pane",
] as const;

export type SettingKind = (typeof settingKinds)[number];

export const machinePanes = ["terminal", "screen"] as const;

export const settingPanes = [
  "sessions",
  "arcs",
  "files",
  "context",
  "memory",
  "needs-you",
  "permissions",
  "mcp",
  "workspaces",
  "workshop",
  "mills",
  "parcels",
  "bots",
  "campaigns",
  "themes",
  "posture",
  "stead",
  ...machinePanes,
] as const;

export type SettingPane = (typeof settingPanes)[number];

export type MachinePane = (typeof machinePanes)[number];

export const steadPlaceKinds = ["workshop", "porch", "store", "mill", "project"] as const;

export type SteadPlaceKind = (typeof steadPlaceKinds)[number];

export type SteadPlace =
  | { kind: "workshop"; creature: string }
  | { kind: "porch" }
  | { kind: "store" }
  | { kind: "mill" }
  | { kind: "project"; creature: string; directory: string };

export const markTones = ["neutral", "good", "caution", "bad"] as const;

export type MarkTone = (typeof markTones)[number];

export type MarkColour = Exclude<MarkTone, "neutral">;

export const rungs = ["lantern", "card", "unfold", "stage"] as const;

export type Rung = (typeof rungs)[number];

export const settingAnswers = ["seen", "pinned", "unpinned", "dismissed"] as const;

export type SettingAnswer = (typeof settingAnswers)[number];

export type SettledOutcome = SettingAnswer | "withdrawn";

export type SettledBy = "keeper" | "creature" | "time";

export type SettingState = "live" | "seen" | "pinned" | "dismissed" | "withdrawn";

export const settingSizes = ["card", "readable", "working"] as const;

export type SettingSize = (typeof settingSizes)[number];

export const settingPlaces = ["beside", "outside"] as const;

export type SettingPlace = (typeof settingPlaces)[number];

export const settingWeights = ["lead", "support", "aside"] as const;

export type SettingWeight = (typeof settingWeights)[number];

export const moods = [
  "calm",
  "brisk",
  "eager",
  "playful",
  "urgent",
  "decisive",
  "tentative",
] as const;

export type Mood = (typeof moods)[number];

export const settingOrigins = ["creature", "keeper"] as const;

export type SettingOrigin = (typeof settingOrigins)[number];

export type SettingUntil = "seen" | "rests" | string;

export interface SettingWhat {
  kind: SettingKind;
  ref: string;
  title?: string;
}

export const agentColors = ["cyan", "magenta", "green", "yellow", "blue"] as const;

export type AgentColor = (typeof agentColors)[number];

export interface SettingAgent {
  name?: string;
  color?: AgentColor;
}

export const agentNameLength = 40;

export const markLength = 24;

export const settingSignals = ["needs-you", "critical"] as const;

export type SettingSignal = (typeof settingSignals)[number];

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
  place: SteadPlace;
  size?: SettingSize;
  where?: SettingPlace;
  seat?: Seat;
  weight?: SettingWeight;
  mood?: Mood;
  agent?: SettingAgent;
  mark?: string;
  markTone?: MarkColour;
  signal?: SettingSignal;
}

export interface ShowProposed {
  setting: Setting;
}

export interface ShowSettled {
  id: string;
  outcome: SettledOutcome;
  by: SettledBy;
  mood?: Mood;
}

export interface ShowChanged {
  setting: Setting;
}

export interface ShowEvents {
  "show.proposed": ShowProposed;
  "show.changed": ShowChanged;
  "show.settled": ShowSettled;
  "show.arranged": ShowArranged;
}

export type ShowEventType = keyof ShowEvents;

export type ShowEventSink = <Type extends ShowEventType>(
  sessionId: string,
  type: Type,
  payload: ShowEvents[Type],
) => void;
