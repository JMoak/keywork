import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NamedSecret } from "../../memory/redaction.ts";
import type { Decider } from "../../models/decide/types.ts";
import type { PermissionAsk, PermissionDecision } from "../../session/journal.ts";
import { answeredByOracle, modelOfRow } from "./calibration.ts";
import { type AskFacts, askFactsOf } from "./facts.ts";
import { inLedgerOrder, keeperLedgerPath } from "./files.ts";
import { keeperGateId, keeperGateSpec, keeperLabelSource } from "./gate.ts";
import { deciderOracle, keeperRuleOracle } from "./oracles.ts";
import {
  type Action,
  type DecisionRecord,
  type Engine,
  type Gate,
  type GateSpec,
  type Label,
  loadRatchet,
  type Mode,
  type Oracle,
  type Ratchet,
  type StateLike,
} from "./ratchet.ts";
import { drawForBlindReview, drawsBlindReview, keeperAuditRate } from "./review.ts";
import { type KeeperContext, keeperState } from "./state.ts";

export {
  decisionsDir,
  keeperLedgerFile,
  keeperLedgerPath,
} from "./files.ts";

export const keeperDailyBudgetUsd = 0.05;
export const keeperTimeoutMs = 10_000;

export const callTagPrefix = "keeper:call:";
export const sessionTagPrefix = "session:";
export const classTagPrefix = "class:";
export const creatureTagPrefix = "creature:";
export const oneWayDoorTag = "door:one-way";

export interface KeeperCall {
  ask: PermissionAsk;
  session: string;
  context: KeeperContext;
  cwd?: string | undefined;
}

export interface AnsweredAsk extends KeeperCall {
  decision: PermissionDecision;
  answeredAt?: string | undefined;
}

export interface KeeperDecisionsOptions {
  nodeState: string;
  decider?: Decider | undefined;
  secrets?: readonly NamedSecret[] | undefined;
  dailyBudgetUsd?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
  ratchet?: Ratchet | undefined;
  auditRate?: number | undefined;
  draw?: (() => number) | undefined;
}

export type SkipReason =
  | "not-a-keeper-verdict"
  | "mismatched-ask"
  | "not-now"
  | "already-recorded"
  | "unavailable";

export type KeeperOutcome =
  | {
      recorded: true;
      recordId: string;
      ruleClass: string;
      recommendation: Action;
      pYes: number;
      answered: boolean;
      agreed?: boolean;
      drawnForReview?: true;
    }
  | { recorded: false; reason: SkipReason; detail?: string };

export interface KeeperGate {
  ratchet: Ratchet;
  engine: Engine;
  gate: Gate;
  oracle: Oracle;
}

export interface KeeperGateShape {
  mode: Mode;
  oracle?: ((oracle: Oracle) => Oracle) | undefined;
  spec?: ((spec: GateSpec) => GateSpec) | undefined;
}

export async function recordKeeperVerdict(
  answered: AnsweredAsk,
  options: KeeperDecisionsOptions,
): Promise<KeeperOutcome> {
  const skipped = skipReasonOf(answered);
  if (skipped !== undefined) return { recorded: false, reason: skipped };
  const ledgerPath = keeperLedgerPath(options.nodeState);
  return inLedgerOrder(ledgerPath, async () => {
    try {
      const shadow = await openKeeperGate(ledgerPath, options, { mode: "shadow" });
      return await recordIn(shadow, answered, options);
    } catch (error) {
      return { recorded: false, reason: "unavailable", detail: messageOf(error) };
    }
  });
}

export function isKeeperVerdict(decision: PermissionDecision): boolean {
  return decision.asked === true && decision.gate === "user";
}

export async function openKeeperGate(
  ledgerPath: string,
  options: KeeperDecisionsOptions,
  shape: KeeperGateShape,
): Promise<KeeperGate> {
  const ratchet = options.ratchet ?? (await loadRatchet());
  await mkdir(dirname(ledgerPath), { recursive: true });
  const decider = options.decider;
  const base =
    decider === undefined
      ? keeperRuleOracle(ratchet)
      : deciderOracle(ratchet, decider, { now: options.now });
  const oracle = shape.oracle?.(base) ?? base;
  const engine = new ratchet.Engine({
    oracle,
    ledger: new ratchet.JsonlLedger(ledgerPath),
    mode: shape.mode,
    timeoutMs: options.timeoutMs ?? keeperTimeoutMs,
    ...(decider !== undefined && {
      dailyBudgetUsd: options.dailyBudgetUsd ?? keeperDailyBudgetUsd,
    }),
  });
  const spec = keeperGateSpec(ratchet, oracle.id);
  return { ratchet, engine, oracle, gate: engine.gate(shape.spec?.(spec) ?? spec) };
}

export function keeperTagsOf(call: KeeperCall, facts: AskFacts): string[] {
  const { session, context } = call;
  return [
    callTagOf(call),
    `${sessionTagPrefix}${session}`,
    `${classTagPrefix}${facts.ruleClass}`,
    `tool:${facts.tool}`,
    `thread:${context.thread}`,
    ...(context.creature === undefined ? [] : [`${creatureTagPrefix}${context.creature}`]),
    ...(context.workshop === undefined ? [] : [`workshop:${context.workshop}`]),
    ...(facts.destructive ? [oneWayDoorTag] : []),
  ];
}

function skipReasonOf({ ask, decision }: AnsweredAsk): SkipReason | undefined {
  if (!isKeeperVerdict(decision)) return "not-a-keeper-verdict";
  if (decision.callId !== ask.callId) return "mismatched-ask";
  if (decision.verdict === "denied" && decision.reason === "not-now") return "not-now";
  return undefined;
}

async function recordIn(
  shadow: KeeperGate,
  answered: AnsweredAsk,
  options: KeeperDecisionsOptions,
): Promise<KeeperOutcome> {
  const facts = askFactsOf(answered.ask, { cwd: answered.cwd, secrets: options.secrets });
  const earlier = await rowForCall(shadow, callTagOf(answered));
  if (earlier?.outcome !== undefined) return { recorded: false, reason: "already-recorded" };
  const state = keeperState(shadow.ratchet, facts, answered.context);
  const row = earlier ?? (await askShadow(shadow, answered, facts, state));
  await shadow.engine.label(row.id, labelOf(answered, row.verdict, options));
  const drawn = row !== earlier && (await drawnForReview(row, facts, state.text, options));
  return outcomeOf(row, facts, answered, drawn);
}

async function rowForCall(
  { engine, gate }: KeeperGate,
  callTag: string,
): Promise<DecisionRecord | undefined> {
  const rows = await engine.ledger.all();
  return rows.find(
    (row) =>
      row.gateId === keeperGateId &&
      row.questionHash === gate.questionHash &&
      !row.failedOpen &&
      row.tags.includes(callTag),
  );
}

async function askShadow(
  { engine, gate }: KeeperGate,
  answered: AnsweredAsk,
  facts: AskFacts,
  state: StateLike,
): Promise<DecisionRecord> {
  const result = await gate.ask(state, {
    baseline: "review",
    tags: keeperTagsOf(answered, facts),
  });
  const row = (await engine.ledger.all()).find((candidate) => candidate.id === result.recordId);
  if (row === undefined) throw new Error(`ratchet wrote no row for ${result.recordId}`);
  return row;
}

function labelOf(
  answered: AnsweredAsk,
  verdict: DecisionRecord["verdict"],
  options: KeeperDecisionsOptions,
): Label {
  const approved = answered.decision.verdict === "granted";
  const now = options.now ?? (() => new Date());
  return {
    at: answered.answeredAt ?? now().toISOString(),
    correct: pYesOf(verdict) >= 0.5 === approved,
    truth: approved,
    source: keeperLabelSource,
    note: labelNoteOf(answered.decision),
  };
}

async function drawnForReview(
  row: DecisionRecord,
  facts: AskFacts,
  state: string,
  options: KeeperDecisionsOptions,
): Promise<boolean> {
  const rate = options.auditRate ?? keeperAuditRate;
  if (!answeredByOracle(row) || !drawsBlindReview(options.draw ?? Math.random, rate)) return false;
  await drawForBlindReview(options.nodeState, {
    recordId: row.id,
    ruleClass: facts.ruleClass,
    model: modelOfRow(row),
    pYes: pYesOf(row.verdict),
    state,
    drawnAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  return true;
}

function outcomeOf(
  row: DecisionRecord,
  facts: AskFacts,
  answered: AnsweredAsk,
  drawn: boolean,
): KeeperOutcome {
  const approved = answered.decision.verdict === "granted";
  const pYes = pYesOf(row.verdict);
  const byOracle = answeredByOracle(row);
  return {
    recorded: true,
    recordId: row.id,
    ruleClass: facts.ruleClass,
    recommendation: row.soft,
    pYes,
    answered: byOracle,
    ...(byOracle && { agreed: pYes >= 0.5 === approved }),
    ...(drawn && { drawnForReview: true as const }),
  };
}

function pYesOf(verdict: DecisionRecord["verdict"]): number {
  return verdict.kind === "judge" ? verdict.pYes : verdict.confidence;
}

function callTagOf({ session, ask }: KeeperCall): string {
  return `${callTagPrefix}${session}:${ask.callId}`;
}

function labelNoteOf(decision: PermissionDecision): string {
  if (decision.verdict === "granted") return `granted ${decision.scope ?? "once"}`;
  return `denied: ${decision.reason ?? "no reason given"}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
