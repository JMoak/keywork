import {
  type Agent,
  type ContextBudget,
  type ContextMeasure,
  compactNow,
  contextBudgetFor,
  declaredContextWindow,
  estimatedMeasureOf,
  type MemoryFlush,
  type Message,
  type SessionStore,
  type SettlePhase,
  settleTurn,
  type TurnSettlement,
} from "@keywork/engine";
import type { AgentComposition } from "./compose.ts";

export interface SettlingSession {
  sessionId: string;
  store: SessionStore;
  agent: Agent;
  measure?: ContextMeasure | undefined;
}

export type SessionFlushes = Pick<AgentComposition, "flushFor">;

export type SweepFlush = () => Promise<unknown>;

export function settleSessionTurn(
  session: SettlingSession,
  history: readonly Message[],
  phase: SettlePhase,
  flushes: SessionFlushes,
): Promise<TurnSettlement> {
  const { store, agent, sessionId } = session;
  return settleTurn({
    store,
    provider: agent.provider,
    history,
    budget: budgetOf(agent),
    flush: flushes.flushFor(sessionId, agent.provider),
    phase,
    measure: measureOf(session),
  });
}

export function compactSessionNow(
  session: SettlingSession,
  instructions: string | undefined,
  flushes: SessionFlushes,
): Promise<TurnSettlement> {
  const { store, agent, sessionId } = session;
  return compactNow({
    store,
    provider: agent.provider,
    budget: budgetOf(agent),
    instructions,
    flush: flushes.flushFor(sessionId, agent.provider),
    measure: measureOf(session),
  });
}

export function budgetOf(agent: Agent): ContextBudget {
  return contextBudgetFor(declaredContextWindow(agent.provider));
}

export function sweepFlushFor(
  store: SessionStore | undefined,
  flush: MemoryFlush | undefined,
): SweepFlush | undefined {
  if (store === undefined) return undefined;
  if (flush === undefined) return async () => undefined;
  return () => flush.flushNow(store.messages());
}

function measureOf({ measure, agent }: SettlingSession): ContextMeasure {
  return measure ?? estimatedMeasureOf(agent);
}
