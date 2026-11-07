import { randomToken } from "./canonical.ts";
import { type ExchangeKey, newExchangeKey } from "./keys.ts";
import {
  claimProof,
  derivePairSecret,
  nonceCommitment,
  type PairRole,
  pairingProof,
  proofMatches,
  shortAuthenticationString,
  transcriptHash,
} from "./sas.ts";
import type { HelloReply, HelloRequest } from "./wire.ts";

export type ConsolePhase = "hello-sent" | "revealed" | "paired" | "aborted";

export type ConsoleAbort = "target-mismatch" | "bad-proof" | "rejected" | "refused";

export interface ConsoleAttempt {
  readonly phase: ConsolePhase;
  readonly role: PairRole;
  readonly caps: readonly string[];
  readonly selfStableId: string;
  readonly targetStableId: string;
  readonly deviceKey: string;
  readonly exchange: ExchangeKey;
  readonly nonce: string;
  readonly reply: HelloReply | null;
  readonly transcript: string | null;
  readonly sas: string | null;
  readonly secret: Buffer | null;
  readonly abort: ConsoleAbort | null;
}

export interface AttemptPlan {
  role: PairRole;
  caps: readonly string[];
  selfStableId: string;
  targetStableId: string;
  deviceKey: string;
}

export interface ConsoleConfirmation {
  sas: string;
  proof: string;
  claimProof?: string;
}

export function beginAttempt(plan: AttemptPlan): { attempt: ConsoleAttempt; hello: HelloRequest } {
  const exchange = newExchangeKey();
  const nonce = randomToken();
  const attempt: ConsoleAttempt = {
    ...plan,
    phase: "hello-sent",
    exchange,
    nonce,
    reply: null,
    transcript: null,
    sas: null,
    secret: null,
    abort: null,
  };
  const commitment = nonceCommitment({
    deviceKey: plan.deviceKey,
    exchangeKey: exchange.publicKey,
    nonce,
  });
  return {
    attempt,
    hello: {
      role: plan.role,
      caps: [...plan.caps],
      deviceKey: plan.deviceKey,
      exchangeKey: exchange.publicKey,
      commitment,
    },
  };
}

export function acceptHelloReply(attempt: ConsoleAttempt, reply: HelloReply): ConsoleAttempt {
  if (attempt.phase !== "hello-sent") return abandoned(attempt, "rejected");
  if (reply.stableId !== attempt.targetStableId) return abandoned(attempt, "target-mismatch");
  const transcript = transcriptHash({
    role: attempt.role,
    console: {
      stableId: attempt.selfStableId,
      deviceKey: attempt.deviceKey,
      exchangeKey: attempt.exchange.publicKey,
      nonce: attempt.nonce,
    },
    target: {
      stableId: attempt.targetStableId,
      deviceKey: reply.deviceKey,
      exchangeKey: reply.exchangeKey,
      nonce: reply.nonce,
    },
  });
  return {
    ...attempt,
    phase: "revealed",
    reply,
    transcript,
    sas: shortAuthenticationString(transcript),
    secret: derivePairSecret(attempt.exchange.agree(reply.exchangeKey), transcript),
  };
}

export function confirmationOf(
  attempt: ConsoleAttempt,
  claimCode?: string,
): ConsoleConfirmation | undefined {
  const { phase, transcript, sas, secret } = attempt;
  if (phase !== "revealed" || transcript === null || sas === null || secret === null) {
    return undefined;
  }
  return {
    sas,
    proof: pairingProof(secret, "console-confirmed", transcript),
    ...(claimCode !== undefined && { claimProof: claimProof(claimCode, transcript) }),
  };
}

export function finishAttempt(attempt: ConsoleAttempt, targetProof: string): ConsoleAttempt {
  const { phase, transcript, secret } = attempt;
  if (phase !== "revealed" || transcript === null || secret === null) {
    return abandoned(attempt, "rejected");
  }
  const expected = pairingProof(secret, "target-paired", transcript);
  return proofMatches(expected, targetProof)
    ? { ...attempt, phase: "paired" }
    : abandoned(attempt, "bad-proof");
}

export function abandoned(attempt: ConsoleAttempt, reason: ConsoleAbort): ConsoleAttempt {
  return { ...attempt, phase: "aborted", secret: null, abort: reason };
}
