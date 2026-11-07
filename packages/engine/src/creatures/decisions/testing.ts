import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskScope, grantCandidates } from "@keywork/shared";
import type { DecideReply, Decider, DecisionRequest } from "../../models/decide/types.ts";
import type {
  AskRule,
  DenyReason,
  PermissionAsk,
  PermissionDecision,
} from "../../session/journal.ts";
import type { DecisionRecord, Ratchet } from "./ratchet.ts";
import { type AnsweredAsk, type KeeperDecisionsOptions, recordKeeperVerdict } from "./record.ts";
import type { KeeperContext } from "./state.ts";

export const conversationOfPip: KeeperContext = {
  creature: "pip",
  thread: "conversation",
  workshop: "host",
};

let calls = 0;

export function askFor(tool: string, args: unknown, rule: AskRule = "default"): PermissionAsk {
  calls += 1;
  return {
    tool,
    callId: `call-${calls}`,
    arguments: args,
    rule,
    rules: grantCandidates(tool, args),
  };
}

export function bashAsk(command: string): PermissionAsk {
  return askFor("bash", { command });
}

export function granted(ask: PermissionAsk, scope: AskScope = "once"): PermissionDecision {
  return {
    tool: ask.tool,
    callId: ask.callId,
    verdict: "granted",
    gate: "user",
    scope,
    asked: true,
  };
}

export function denied(ask: PermissionAsk, reason?: DenyReason): PermissionDecision {
  return {
    tool: ask.tool,
    callId: ask.callId,
    verdict: "denied",
    gate: "user",
    asked: true,
    ...(reason !== undefined && { reason }),
  };
}

export function answeredAsk(
  ask: PermissionAsk,
  decision: PermissionDecision,
  overrides: Partial<AnsweredAsk> = {},
): AnsweredAsk {
  return {
    ask,
    decision,
    session: "session-1",
    context: conversationOfPip,
    answeredAt: "2026-11-05T12:00:00.000Z",
    ...overrides,
  };
}

export async function scratchNode(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keeper-decisions-"));
}

export async function ledgerRows(ratchet: Ratchet, path: string): Promise<DecisionRecord[]> {
  return ratchet.parseJsonlLedger(await readFile(path, "utf8"));
}

export interface ScriptedDecider extends Decider {
  readonly requests: DecisionRequest[];
}

export function scriptedDecider(
  answer: (request: DecisionRequest) => DecideReply,
): ScriptedDecider {
  const requests: DecisionRequest[] = [];
  return {
    reference: { provider: "local", model: "nimble-0.8b" },
    requests,
    decide: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
}

export function yesWith(pYes: number, costUsd = 0.0002): (request: DecisionRequest) => DecideReply {
  return (request) => ({
    ok: true,
    model: "nimble-0.8b@2026-10-01",
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: "noul" as const, pYes, confidence: Math.max(pYes, 1 - pYes) },
      ]),
    ),
    usage: {
      inputTokens: 120,
      questions: Object.keys(request.questions).length,
      cost: { usd: costUsd, source: "provider" },
    },
    latencyMs: 40,
  });
}

export const promotableClass = "bash make build *";

export async function answerAll(
  options: KeeperDecisionsOptions,
  commands: readonly string[],
  verdict: "granted" | "denied",
  session = "session-1",
): Promise<void> {
  for (const command of commands) {
    const ask = bashAsk(command);
    const decision = verdict === "granted" ? granted(ask) : denied(ask, "unsafe");
    await recordKeeperVerdict(answeredAsk(ask, decision, { session }), options);
  }
}

export async function promotableNode(ratchet: Ratchet): Promise<string> {
  promotable ??= answeredForPromotion(ratchet);
  const fresh = await scratchNode();
  await cp(await promotable, fresh, { recursive: true });
  return fresh;
}

let promotable: Promise<string> | undefined;

async function answeredForPromotion(ratchet: Ratchet): Promise<string> {
  const nodeState = await scratchNode();
  const options = { nodeState, ratchet, draw: () => 1 };
  for (let session = 0; session < 20; session += 1) {
    const calls = Array.from({ length: 10 }, (_, call) => `make build JOBS=${session * 10 + call}`);
    await answerAll(options, calls, "granted", `session-${session}`);
  }
  return nodeState;
}
