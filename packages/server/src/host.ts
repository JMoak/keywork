import type { Message, PromptOrigin } from "@keywork/engine";
import type { AnswerOutcome, AskVerdict, PendingAsk } from "./asks.ts";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  costNanos?: number;
  arc?: string;
  bot?: string;
}

export interface SessionDetail extends SessionSummary {
  cwd: string;
  live: boolean;
  messages: readonly Message[];
  asOf: number;
}

export type PromptOutcome = "accepted" | "missing";

export type InjectOutcome = "started" | "queued" | "missing";

export type AbortOutcome = "aborted" | "idle" | "missing";

export interface SessionHost {
  list(): Promise<readonly SessionSummary[]>;
  read(id: string): Promise<SessionDetail | undefined>;
  create(): Promise<SessionSummary>;
  prompt(id: string, text: string): Promise<PromptOutcome>;
  inject(id: string, text: string, origin: PromptOrigin): Promise<InjectOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  asks(): Promise<readonly PendingAsk[]>;
  answerAsk(callId: string, verdict: AskVerdict): Promise<AnswerOutcome>;
  close(): Promise<void>;
}
