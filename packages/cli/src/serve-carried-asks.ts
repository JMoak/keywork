import { join } from "node:path";
import {
  type AnsweredAsk,
  type AnswerOrigin,
  type KeeperContext,
  toolActivityOf,
} from "@keywork/engine";
import type { AskKeeping, CarriedAnswer, KeptAsk } from "@keywork/server";
import { jsonFileStore } from "@keywork/shared";

export function keptAsksFileIn(workspaceState: string): string {
  return join(workspaceState, "asks.json");
}

export function askKeepingAt(file: string): AskKeeping {
  const store = jsonFileStore<KeptAsk[]>({
    file,
    mode: "lenient",
    private: true,
    validate: keptAsksOf,
  });
  return {
    read: () => store.read() ?? [],
    write: (asks) => store.write([...asks]),
  };
}

export function carriedPrompt(ask: KeptAsk, answer: CarriedAnswer): string {
  const call = toolActivityOf(ask.tool, ask.arguments);
  if (answer.verdict === "granted") {
    return `${answeredWhileStopped} they allowed ${call}. Make that call again now, the ${ask.tool} tool with exactly these arguments, and it runs this once without asking: ${JSON.stringify(ask.arguments)}. Then carry on with the work.`;
  }
  const said = answer.denial.note === undefined ? "" : ` They said: "${answer.denial.note}"`;
  return `${answeredWhileStopped} they declined ${call}${reasonOf(answer)}.${said} It did not run and changed nothing. Do not ask for it again; carry on without it, or say plainly what you cannot do.`;
}

export function answerOriginOf(ask: KeptAsk, answer: CarriedAnswer): AnswerOrigin {
  return {
    kind: "answer",
    callId: ask.callId,
    tool: ask.tool,
    verdict: answer.verdict,
    ...(answer.denial.reason !== undefined && { reason: answer.denial.reason }),
    ...(answer.denial.note !== undefined && { note: answer.denial.note }),
  };
}

export function carriedVerdict(
  ask: KeptAsk,
  answer: CarriedAnswer,
  facts: { context: KeeperContext; cwd: string; at: string },
): AnsweredAsk {
  return {
    ask: {
      tool: ask.tool,
      callId: ask.callId,
      arguments: ask.arguments,
      rule: ask.rule,
      rules: ask.rules,
      ...(ask.preview !== undefined && { preview: ask.preview }),
    },
    decision: {
      tool: ask.tool,
      callId: ask.callId,
      verdict: answer.verdict,
      gate: "user",
      asked: true,
      ...(answer.verdict === "granted" && { scope: "once" as const }),
      ...(answer.denial.reason !== undefined && { reason: answer.denial.reason }),
      ...(answer.denial.note !== undefined && { note: answer.denial.note }),
    },
    session: ask.sessionId,
    context: facts.context,
    cwd: facts.cwd,
    answeredAt: facts.at,
  };
}

export function unansweredCalls(
  messages: readonly { role: string; parts: readonly { type: string; callId?: string }[] }[],
): string[] {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (last === undefined) return [];
  const settled = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool-result" && part.callId !== undefined ? [part.callId] : [],
      ),
    ),
  );
  return last.parts.flatMap((part) =>
    part.type === "tool-call" && part.callId !== undefined && !settled.has(part.callId)
      ? [part.callId]
      : [],
  );
}

const answeredWhileStopped =
  "The keeper answered the question that waited while the engine was stopped:";

function reasonOf({ denial }: CarriedAnswer): string {
  switch (denial.reason) {
    case "unsafe":
      return ", judging it unsafe";
    case "not-now":
      return ", not now";
    default:
      return "";
  }
}

function keptAsksOf(data: unknown): KeptAsk[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is KeptAsk =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as KeptAsk).sessionId === "string" &&
      typeof (entry as KeptAsk).callId === "string" &&
      typeof (entry as KeptAsk).tool === "string" &&
      typeof (entry as KeptAsk).askedAt === "string" &&
      Array.isArray((entry as KeptAsk).rules),
  );
}
