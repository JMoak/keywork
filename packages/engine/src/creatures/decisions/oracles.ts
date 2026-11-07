import { formatReference } from "../../inference/references.ts";
import type { Decider, DecisionAnswer, DecisionQuestion } from "../../models/decide/types.ts";
import type {
  Decision,
  JudgeQuestion,
  JudgeVerdict,
  Oracle,
  Question,
  Ratchet,
  VerdictRule,
} from "./ratchet.ts";
import { type TrustedFacts, trustedFactsOf } from "./state.ts";

export const keeperRulesId = "keeper-rules";

export interface RuleRow {
  readonly pYes: number;
  readonly holds: (facts: TrustedFacts) => boolean;
}

export function keeperRuleOracle(
  ratchet: Pick<Ratchet, "RuleOracle" | "judgeVerdictFrom">,
): Oracle {
  const rules = keeperRuleTable.map(
    ({ pYes, holds }): VerdictRule =>
      (state, question) =>
        question.kind === "judge" && holds(trustedFactsOf(state))
          ? ratchet.judgeVerdictFrom(question, pYes)
          : undefined,
  );
  return new ratchet.RuleOracle(rules, keeperRulesId);
}

export interface DeciderOracleOptions {
  now?: (() => Date) | undefined;
}

export function deciderOracle(
  ratchet: Pick<Ratchet, "judgeVerdictFrom">,
  decider: Decider,
  options: DeciderOracleOptions = {},
): Oracle {
  const id = `decide:${formatReference(decider.reference)}`;
  const now = options.now ?? (() => new Date());
  return {
    id,
    async decide(state, questions, opts) {
      const judged = questions.map(judgeOnly);
      const reply = await decider.decide({
        state,
        questions: Object.fromEntries(judged.map((question) => [question.id, noulOf(question)])),
        signal: opts?.signal,
      });
      if (!reply.ok) throw new Error(`${reply.failure.reason}: ${reply.failure.message}`);
      const at = now().toISOString();
      const cost = (reply.usage.cost?.usd ?? 0) / Math.max(1, judged.length);
      return judged.map(
        (question): Decision => ({
          verdict: verdictOf(ratchet, question, reply.answers[question.id]),
          oracle: id,
          model: reply.model,
          latencyMs: reply.latencyMs,
          cost,
          at,
        }),
      );
    },
  };
}

export const keeperRuleTable: readonly RuleRow[] = [
  { pYes: 0.02, holds: (facts) => facts.get("destructive") === "true" },
  { pYes: 0.1, holds: (facts) => rulesOf(facts).some(sendsWorkAway) },
  { pYes: 0.96, holds: (facts) => everyRule(facts, isRoutineWork) },
  { pYes: 0.9, holds: (facts) => everyRule(facts, isLocalHistoryWrite) },
  { pYes: 0.9, holds: editsInsideTheWorkshop },
];

const routineWork: readonly RegExp[] = [
  /^bash (?:npm|pnpm|yarn) (?:test|run|exec) \*$/,
  /^bash bun (?:test|run|x) \*$/,
  /^bash (?:cargo|go|dotnet|swift) (?:build|test|check|fmt|clippy|vet|format) \*$/,
  /^bash (?:pytest|vitest|jest|tsc|biome|eslint|prettier|ruff|mypy|make)(?: \S+)? \*$/,
];

const localHistoryWrites: readonly RegExp[] = [/^bash git (?:add|commit|stash|switch) \*$/];

const workSentAway: readonly RegExp[] = [
  /^bash (?:npm|pnpm|yarn|bun|cargo) publish\b/,
  /^bash git push\b/,
  /^bash (?:curl|wget|scp|rsync|ssh|sftp|ftp|nc)\b/,
  /^bash (?:docker|podman) push\b/,
  /^bash gh (?:release|pr|repo)\b/,
];

function isRoutineWork(rule: string): boolean {
  return routineWork.some((pattern) => pattern.test(rule));
}

function isLocalHistoryWrite(rule: string): boolean {
  return localHistoryWrites.some((pattern) => pattern.test(rule));
}

function sendsWorkAway(rule: string): boolean {
  return workSentAway.some((pattern) => pattern.test(rule));
}

function editsInsideTheWorkshop(facts: TrustedFacts): boolean {
  const tool = facts.get("tool");
  return (tool === "write" || tool === "edit") && facts.get("inside_workspace") === "true";
}

function everyRule(facts: TrustedFacts, holds: (rule: string) => boolean): boolean {
  const rules = rulesOf(facts);
  return rules.length > 0 && rules.every(holds);
}

function rulesOf(facts: TrustedFacts): string[] {
  const rendered = facts.get("rule");
  return rendered === undefined || rendered === "none" ? [] : rendered.split(", ");
}

function judgeOnly(question: Question): JudgeQuestion {
  if (question.kind !== "judge") {
    throw new Error(`the keeper gate asks judge questions only, not ${question.kind}`);
  }
  return question;
}

function noulOf(question: JudgeQuestion): DecisionQuestion {
  const criteria = question.criteria;
  return {
    type: "noul",
    instructions: question.prompt,
    ...(criteria !== undefined && {
      criteria: {
        ...(criteria.yes !== undefined && { true: criteria.yes }),
        ...(criteria.no !== undefined && { false: criteria.no }),
      },
    }),
  };
}

function verdictOf(
  ratchet: Pick<Ratchet, "judgeVerdictFrom">,
  question: JudgeQuestion,
  answer: DecisionAnswer | undefined,
): JudgeVerdict {
  if (answer === undefined) throw new Error(`malformed: no answer for ${question.id}`);
  if (answer.type === "refusal") throw new Error(`refused: ${answer.reason}`);
  if (answer.type !== "noul" || !Number.isFinite(answer.pYes)) {
    throw new Error(`malformed: ${question.id} needs a yes probability`);
  }
  return ratchet.judgeVerdictFrom(question, answer.pYes);
}
