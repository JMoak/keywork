import type {
  AskResult,
  JudgeQuestion,
  JudgeVerdict,
  Gate as PackageGate,
  GateSpec as PackageGateSpec,
  Verdict,
} from "@jmoak/ratchet";

export type {
  AcceptancePlan,
  AcceptanceResult,
  Action,
  BorrowedVia,
  BuildOptions,
  DecideOptions,
  Decision,
  DecisionRecord,
  DigestValue,
  Engine,
  EngineOptions,
  EvidenceGrade,
  FitClass,
  FittedThreshold,
  FloorRule,
  GateAskOptions,
  GatePolicy,
  GradeOptions,
  JudgeQuestion,
  JudgeVerdict,
  Ledger,
  MemberRecord,
  Mode,
  Oracle,
  Outcome,
  PickQuestion,
  PickVerdict,
  ProfileProvenance,
  Question,
  QuestionKind,
  RateQuestion,
  RateVerdict,
  ResolvedPlan,
  Ruling,
  Scored,
  SourceCounts,
  StateBuilder,
  StateInput,
  StateLike,
  UntrustedOptions,
  Verdict,
  VerdictRule,
} from "@jmoak/ratchet";

export type Ratchet = typeof import("@jmoak/ratchet");
export type GateSpec = PackageGateSpec<JudgeQuestion>;
export type Gate = PackageGate<JudgeVerdict>;
export type AskedDecision<V extends Verdict = Verdict> = AskResult<V>["decision"];
export type Label = Parameters<InstanceType<Ratchet["Engine"]>["label"]>[1];
export type Interval = ReturnType<Ratchet["wilsonInterval"]>;
export type JudgeExtra = NonNullable<Parameters<Ratchet["judge"]>[1]>;

export const ratchetPackage = "@jmoak/ratchet";

export class RatchetUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`The ${ratchetPackage} dependency could not be loaded: ${messageOf(cause)}`, {
      cause,
    });
    this.name = "RatchetUnreachableError";
  }
}

export async function loadRatchet(): Promise<Ratchet> {
  try {
    return await import("@jmoak/ratchet");
  } catch (cause) {
    throw new RatchetUnreachableError(cause);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
