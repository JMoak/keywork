import type { PendingAsk } from "./asks.ts";
import type { ChangesSummary, SessionRow, SessionSummary, WaitingAsks } from "./host.ts";

export interface DeskFacts {
  asks: readonly PendingAsk[];
  live(sessionId: string): boolean;
  working(sessionId: string): boolean;
  changes(sessionId: string): ChangesSummary | undefined;
}

export function deskRowOf(summary: SessionSummary, facts: DeskFacts): SessionRow {
  const changes = facts.changes(summary.id);
  return {
    ...summary,
    live: facts.live(summary.id),
    working: facts.working(summary.id),
    waiting: waitingOn(summary.id, facts.asks),
    ...(changes !== undefined && { changes }),
  };
}

function waitingOn(sessionId: string, asks: readonly PendingAsk[]): WaitingAsks {
  const pending = asks.filter((ask) => ask.sessionId === sessionId);
  return { asks: pending.length, tools: [...new Set(pending.map((ask) => ask.tool))].sort() };
}
