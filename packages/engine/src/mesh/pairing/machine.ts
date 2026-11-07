import type { ExchangeKey } from "./keys.ts";
import {
  claimProof,
  derivePairSecret,
  nonceCommitment,
  type PairingTranscript,
  type PairRole,
  pairingProof,
  proofMatches,
  shortAuthenticationString,
  transcriptHash,
} from "./sas.ts";

export type Confirmation = "on-device" | "claim-code" | "endorsement";

export type AttemptPhase = "identified" | "confirming" | "stored" | "aborted";

export type AbortReason =
  | "out-of-order"
  | "caller-changed"
  | "commitment-mismatch"
  | "sas-mismatch"
  | "bad-proof"
  | "bad-claim-code"
  | "wrong-confirmation"
  | "expired"
  | "cancelled";

export type HelloRefusal =
  | "not-the-owner"
  | "other-tailnet"
  | "needs-a-human"
  | "unclaimed-needs-a-console";

export interface PairingCaller {
  stableId: string;
  userId: string | null;
  tags: readonly string[];
}

export type TailnetIdentitySource = "stable-id" | "magicdns";

export interface SelfIdentity {
  stableId: string;
  tailnetId: string;
  userId: string | null;
  source: TailnetIdentitySource;
}

export interface Owner {
  tailnetId: string;
  userId: string;
  claimedAt: string;
}

export interface IdentifyContext {
  self: SelfIdentity;
  owner: Owner | null;
  headless: boolean;
}

export interface ConsoleOffer {
  deviceKey: string;
  exchangeKey: string;
  commitment: string;
}

export interface TargetOffer {
  stableId: string;
  deviceKey: string;
  exchange: ExchangeKey;
  nonce: string;
}

export interface TargetAttempt {
  readonly id: string;
  readonly phase: AttemptPhase;
  readonly caller: PairingCaller;
  readonly role: PairRole;
  readonly caps: readonly string[];
  readonly confirmation: Confirmation;
  readonly console: ConsoleOffer;
  readonly target: TargetOffer;
  readonly expiresAt: number;
  readonly consoleNonce: string | null;
  readonly transcript: string | null;
  readonly sas: string | null;
  readonly secret: Buffer | null;
  readonly consoleConfirmed: boolean;
  readonly targetConfirmed: boolean;
  readonly abort: AbortReason | null;
}

export type OpenAttempt = Pick<
  TargetAttempt,
  "id" | "caller" | "role" | "caps" | "confirmation" | "console" | "target" | "expiresAt"
>;

export type PairingStep =
  | { kind: "reveal"; from: PairingCaller; nonce: string }
  | {
      kind: "console-confirm";
      from: PairingCaller;
      sas: string;
      proof: string;
      claimProof?: string | undefined;
    }
  | { kind: "target-confirm"; by: "on-device" | "endorsement"; sas: string }
  | { kind: "cancel" };

export interface StepContext {
  now: number;
  claimCode: string | null;
}

export function identify(
  caller: PairingCaller,
  role: PairRole,
  context: IdentifyContext,
): { confirmation: Confirmation } | { refused: HelloRefusal } {
  const { self, owner } = context;
  if (owner === null) return identifyForClaim(caller, role, context);
  if (self.tailnetId !== owner.tailnetId) return { refused: "other-tailnet" };
  if (caller.userId !== null && caller.userId !== owner.userId) return { refused: "not-the-owner" };
  if (role === "console" && caller.userId === null) return { refused: "needs-a-human" };
  return { confirmation: "endorsement" };
}

export function openAttempt(opened: OpenAttempt): TargetAttempt {
  return {
    ...opened,
    phase: "identified",
    consoleNonce: null,
    transcript: null,
    sas: null,
    secret: null,
    consoleConfirmed: false,
    targetConfirmed: false,
    abort: null,
  };
}

export function advance(
  attempt: TargetAttempt,
  step: PairingStep,
  context: StepContext,
): TargetAttempt {
  if (isSettled(attempt)) return attempt;
  if (context.now >= attempt.expiresAt) return aborted(attempt, "expired");
  switch (step.kind) {
    case "cancel":
      return aborted(attempt, "cancelled");
    case "reveal":
      return revealed(attempt, step);
    case "console-confirm":
      return consoleConfirmed(attempt, step, context);
    case "target-confirm":
      return targetConfirmed(attempt, step);
  }
}

export function isSettled(attempt: TargetAttempt): boolean {
  return attempt.phase === "stored" || attempt.phase === "aborted";
}

export function transcriptOf(attempt: TargetAttempt, consoleNonce: string): PairingTranscript {
  return {
    role: attempt.role,
    console: {
      stableId: attempt.caller.stableId,
      deviceKey: attempt.console.deviceKey,
      exchangeKey: attempt.console.exchangeKey,
      nonce: consoleNonce,
    },
    target: {
      stableId: attempt.target.stableId,
      deviceKey: attempt.target.deviceKey,
      exchangeKey: attempt.target.exchange.publicKey,
      nonce: attempt.target.nonce,
    },
  };
}

function identifyForClaim(
  caller: PairingCaller,
  role: PairRole,
  { self, headless }: IdentifyContext,
): { confirmation: Confirmation } | { refused: HelloRefusal } {
  if (role !== "console") return { refused: "unclaimed-needs-a-console" };
  if (caller.userId === null) return { refused: "needs-a-human" };
  if (self.userId !== null && caller.userId !== self.userId) return { refused: "not-the-owner" };
  return { confirmation: headless ? "claim-code" : "on-device" };
}

function revealed(
  attempt: TargetAttempt,
  step: Extract<PairingStep, { kind: "reveal" }>,
): TargetAttempt {
  if (attempt.phase !== "identified") return aborted(attempt, "out-of-order");
  if (!sameCaller(attempt.caller, step.from)) return aborted(attempt, "caller-changed");
  const committed = nonceCommitment({
    deviceKey: attempt.console.deviceKey,
    exchangeKey: attempt.console.exchangeKey,
    nonce: step.nonce,
  });
  if (!proofMatches(attempt.console.commitment, committed)) {
    return aborted(attempt, "commitment-mismatch");
  }
  const transcript = transcriptHash(transcriptOf(attempt, step.nonce));
  const shared = attempt.target.exchange.agree(attempt.console.exchangeKey);
  return {
    ...attempt,
    phase: "confirming",
    consoleNonce: step.nonce,
    transcript,
    sas: shortAuthenticationString(transcript),
    secret: derivePairSecret(shared, transcript),
  };
}

function consoleConfirmed(
  attempt: TargetAttempt,
  step: Extract<PairingStep, { kind: "console-confirm" }>,
  context: StepContext,
): TargetAttempt {
  const confirming = confirmingState(attempt);
  if (confirming === undefined || attempt.consoleConfirmed) {
    return aborted(attempt, "out-of-order");
  }
  if (!sameCaller(attempt.caller, step.from)) return aborted(attempt, "caller-changed");
  if (!proofMatches(confirming.sas, step.sas)) return aborted(attempt, "sas-mismatch");
  const expected = pairingProof(confirming.secret, "console-confirmed", confirming.transcript);
  if (!proofMatches(expected, step.proof)) return aborted(attempt, "bad-proof");
  if (attempt.confirmation !== "claim-code") return settled({ ...attempt, consoleConfirmed: true });
  if (!claimCodeHolds(context.claimCode, step.claimProof, confirming.transcript)) {
    return aborted(attempt, "bad-claim-code");
  }
  return settled({ ...attempt, consoleConfirmed: true, targetConfirmed: true });
}

function targetConfirmed(
  attempt: TargetAttempt,
  step: Extract<PairingStep, { kind: "target-confirm" }>,
): TargetAttempt {
  const confirming = confirmingState(attempt);
  if (confirming === undefined || attempt.targetConfirmed) {
    return aborted(attempt, "out-of-order");
  }
  if (attempt.confirmation !== step.by) return aborted(attempt, "wrong-confirmation");
  if (!proofMatches(confirming.sas, step.sas)) return aborted(attempt, "sas-mismatch");
  return settled({ ...attempt, targetConfirmed: true });
}

interface Confirming {
  transcript: string;
  sas: string;
  secret: Buffer;
}

function confirmingState(attempt: TargetAttempt): Confirming | undefined {
  const { phase, transcript, sas, secret } = attempt;
  if (phase !== "confirming" || transcript === null || sas === null || secret === null) {
    return undefined;
  }
  return { transcript, sas, secret };
}

function claimCodeHolds(
  claimCode: string | null,
  proof: string | undefined,
  transcript: string,
): boolean {
  return (
    claimCode !== null &&
    proof !== undefined &&
    proofMatches(claimProof(claimCode, transcript), proof)
  );
}

function settled(attempt: TargetAttempt): TargetAttempt {
  return attempt.consoleConfirmed && attempt.targetConfirmed
    ? { ...attempt, phase: "stored" }
    : attempt;
}

function aborted(attempt: TargetAttempt, reason: AbortReason): TargetAttempt {
  return { ...attempt, phase: "aborted", secret: null, abort: reason };
}

function sameCaller(left: PairingCaller, right: PairingCaller): boolean {
  return left.stableId === right.stableId && left.userId === right.userId;
}
