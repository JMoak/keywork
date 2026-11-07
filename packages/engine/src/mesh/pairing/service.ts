import { actorOf } from "../audit/admissions.ts";
import type { AuditActor, AuditLog } from "../audit/log.ts";
import type { MeshCaller } from "../listener/admission.ts";
import { randomToken } from "./canonical.ts";
import { liveClaimCode, spendClaimCode } from "./claim-code.ts";
import type { DeviceKey, KeyStore } from "./keys.ts";
import { newExchangeKey } from "./keys.ts";
import { isFresh, macHolds, macProofOf, replayGuard, requestTarget } from "./mac.ts";
import {
  type AbortReason,
  advance,
  type Confirmation,
  type HelloRefusal,
  identify,
  isSettled,
  type Owner,
  openAttempt,
  type PairingCaller,
  type PairingStep,
  type SelfIdentity,
  type TargetAttempt,
} from "./machine.ts";
import { type PairRole, pairingProof } from "./sas.ts";
import {
  type PairRecord,
  type PairStore,
  pairSecretName,
  pairSecretOf,
  savePairSecret,
  withoutPair,
  withPair,
} from "./store.ts";
import {
  consoleConfirmSchema,
  endorseSchema,
  type HelloReply,
  helloRequestSchema,
  type PairedReply,
  revealSchema,
} from "./wire.ts";

export type RefusalKind = "invalid" | "forbidden" | "missing" | "unauthenticated";

export interface Refusal {
  refused: RefusalKind;
  error: string;
}

export type AuthFailure =
  | "no-proof"
  | "unknown-pair"
  | "node-mismatch"
  | "human-mismatch"
  | "tags-changed"
  | "stale"
  | "bad-mac"
  | "replayed";

export interface Authenticated {
  pair: PairRecord;
  caller: MeshCaller;
  body: string;
}

export interface PendingPairing {
  pairingId: string;
  peerStableId: string;
  peerUserId: string | null;
  role: PairRole;
  caps: readonly string[];
  confirmation: Confirmation;
  phase: TargetAttempt["phase"];
  sas: string | null;
  expiresAt: string;
}

export type PairRemoval = "keeper" | "revocation";

export type PairingEvent =
  | { type: "mesh.pairing.refused"; peerStableId: string; reason: HelloRefusal }
  | { type: "mesh.pairing.started"; pairing: PendingPairing }
  | { type: "mesh.pairing.confirming"; pairing: PendingPairing }
  | { type: "mesh.pairing.aborted"; pairingId: string; reason: AbortReason }
  | { type: "mesh.pair.added"; pair: PairRecord }
  | { type: "mesh.pair.removed"; pairId: string; peerStableId: string; by: PairRemoval };

export interface PairingServiceOptions {
  deviceKey: DeviceKey;
  keys: KeyStore;
  store: PairStore;
  audit: AuditLog;
  self(): Promise<SelfIdentity>;
  headless?: boolean | undefined;
  attemptTtlMs?: number | undefined;
  now?: (() => number) | undefined;
  onEvent?: ((event: PairingEvent) => void) | undefined;
}

export interface PairingService {
  claimState(): "unclaimed" | "claimed";
  owner(): Owner | null;
  pairs(): PairRecord[];
  pending(): PendingPairing[];
  hello(caller: MeshCaller, body: unknown): Promise<HelloReply | Refusal>;
  reveal(caller: MeshCaller, pairingId: string, body: unknown): Promise<PairedReply | Refusal>;
  confirm(caller: MeshCaller, pairingId: string, body: unknown): Promise<PairedReply | Refusal>;
  status(caller: MeshCaller, pairingId: string): Promise<PairedReply | Refusal>;
  cancel(caller: MeshCaller, pairingId: string): Promise<PairedReply | Refusal>;
  confirmOnDevice(pairingId: string, sas: string): Promise<PairedReply | Refusal>;
  endorse(
    endorser: Authenticated,
    pairingId: string,
    body: unknown,
  ): Promise<PairedReply | Refusal>;
  authenticate(request: Request, caller: MeshCaller): Promise<Authenticated | Refusal>;
  unpair(pairId: string, by: PairRemoval): Promise<PairRecord | undefined>;
}

export const defaultAttemptTtlMs = 5 * 60_000;

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "refused" in value;
}

export function refusal(refused: RefusalKind, error: string): Refusal {
  return { refused, error };
}

export function pairingService(options: PairingServiceOptions): PairingService {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, TargetAttempt>();
  const replays = replayGuard();
  const emit = (event: PairingEvent) => options.onEvent?.(event);

  const audit = async (
    actor: AuditActor,
    capability: string,
    request: unknown,
    outcome: { allowed: boolean; reason: string },
  ) => {
    const self = await options.self();
    await options.audit.append({
      actor,
      target: self.stableId,
      capability,
      request,
      decision: outcome.allowed ? "allow" : "deny",
      reason: outcome.reason,
    });
  };

  const prune = () => {
    for (const [id, attempt] of attempts) if (now() >= attempt.expiresAt) attempts.delete(id);
  };

  const live = (pairingId: string): TargetAttempt | undefined => {
    prune();
    return attempts.get(pairingId);
  };

  const verified = async (
    request: Request,
    caller: MeshCaller,
  ): Promise<Authenticated | AuthFailure> => {
    const proof = macProofOf(request.headers);
    if (proof === undefined) return "no-proof";
    const pair = options.store.read().pairs.find(({ id }) => id === proof.pairId);
    if (pair === undefined) return "unknown-pair";
    const mismatch = identityMismatch(pair, caller);
    if (mismatch !== undefined) return mismatch;
    if (!isFresh(proof, now())) return "stale";
    const body = await request.text();
    const secret = await pairSecretOf(options.keys, pair.id);
    const signed = { method: request.method, target: requestTarget(request.url), body };
    if (secret === undefined || !macHolds(secret, proof, signed)) return "bad-mac";
    if (!replays.accept(proof, now())) return "replayed";
    return { pair, caller, body };
  };

  const store = async (attempt: TargetAttempt): Promise<void> => {
    const { caller, console: offer, role, caps, confirmation, secret } = attempt;
    if (secret === null) return;
    const self = await options.self();
    const before = options.store.read();
    const pair: PairRecord = {
      id: attempt.id,
      peerStableId: caller.stableId,
      peerUserId: caller.userId,
      peerTags: [...caller.tags],
      peerDeviceKey: offer.deviceKey,
      role,
      caps: [...caps],
      endpoint: null,
      createdAt: new Date(now()).toISOString(),
      confirmedBy: confirmation,
    };
    const owner = before.owner ?? claimedBy(self, caller, now());
    const after = withPair({ ...before, owner }, pair);
    await savePairSecret(options.keys, pair.id, secret);
    options.store.write(after);
    await forgetReplacedSecrets(options.keys, before.pairs, after.pairs);
    if (confirmation === "claim-code") await spendClaimCode(options.keys);
    emit({ type: "mesh.pair.added", pair });
  };

  const step = async (
    attempt: TargetAttempt,
    input: PairingStep,
    actor: AuditActor,
    capability: string,
  ): Promise<PairedReply> => {
    const claimCode =
      attempt.confirmation === "claim-code" ? await liveClaimCode(options.keys, now()) : null;
    const current = attempts.get(attempt.id) ?? attempt;
    const next = advance(current, input, { now: now(), claimCode });
    attempts.set(attempt.id, next);
    await audit(actor, capability, { pairingId: attempt.id, step: input.kind }, outcomeOf(next));
    if (next.phase === "aborted" && current.phase !== "aborted") {
      emit({ type: "mesh.pairing.aborted", pairingId: next.id, reason: next.abort ?? "cancelled" });
    }
    if (next.phase === "confirming" && current.phase === "identified") {
      emit({ type: "mesh.pairing.confirming", pairing: pendingOf(next) });
    }
    if (next.phase === "stored" && current.phase !== "stored") await store(next);
    return replyOf(next);
  };

  const ownedAttempt = (caller: MeshCaller, pairingId: string): TargetAttempt | Refusal => {
    const attempt = live(pairingId);
    if (attempt === undefined || attempt.caller.stableId !== caller.node.stableId) {
      return refusal("missing", "no pairing attempt has that id");
    }
    return attempt;
  };

  return {
    claimState: () => (options.store.read().owner === null ? "unclaimed" : "claimed"),
    owner: () => options.store.read().owner,
    pairs: () => options.store.read().pairs,
    pending: () => {
      prune();
      return [...attempts.values()].filter((attempt) => !isSettled(attempt)).map(pendingOf);
    },

    hello: async (caller, body) => {
      const parsed = helloRequestSchema.safeParse(body);
      if (!parsed.success)
        return refusal("invalid", parsed.error.issues[0]?.message ?? "bad hello");
      const hello = parsed.data;
      const self = await options.self();
      const peer = pairingCallerOf(caller);
      const identified = identify(peer, hello.role, {
        self,
        owner: options.store.read().owner,
        headless: options.headless === true,
      });
      if ("refused" in identified) {
        await audit(actorOf(caller), "pair.hello", hello, {
          allowed: false,
          reason: identified.refused,
        });
        emit({
          type: "mesh.pairing.refused",
          peerStableId: peer.stableId,
          reason: identified.refused,
        });
        return refusal("forbidden", identified.refused);
      }
      const attempt = openAttempt({
        id: randomToken(),
        caller: peer,
        role: hello.role,
        caps: hello.caps,
        confirmation: identified.confirmation,
        console: {
          deviceKey: hello.deviceKey,
          exchangeKey: hello.exchangeKey,
          commitment: hello.commitment,
        },
        target: {
          stableId: self.stableId,
          deviceKey: options.deviceKey.publicKey,
          exchange: newExchangeKey(),
          nonce: randomToken(),
        },
        expiresAt: now() + (options.attemptTtlMs ?? defaultAttemptTtlMs),
      });
      attempts.set(attempt.id, attempt);
      await audit(actorOf(caller), "pair.hello", hello, {
        allowed: true,
        reason: `identified; confirm by ${attempt.confirmation}`,
      });
      emit({ type: "mesh.pairing.started", pairing: pendingOf(attempt) });
      return {
        pairingId: attempt.id,
        stableId: self.stableId,
        deviceKey: attempt.target.deviceKey,
        exchangeKey: attempt.target.exchange.publicKey,
        nonce: attempt.target.nonce,
        confirmation: attempt.confirmation,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      };
    },

    reveal: async (caller, pairingId, body) => {
      const attempt = ownedAttempt(caller, pairingId);
      if (isRefusal(attempt)) return attempt;
      const parsed = revealSchema.safeParse(body);
      if (!parsed.success) return refusal("invalid", "a reveal carries the console nonce");
      const reveal = {
        kind: "reveal",
        from: pairingCallerOf(caller),
        nonce: parsed.data.nonce,
      } as const;
      return step(attempt, reveal, actorOf(caller), "pair.reveal");
    },

    confirm: async (caller, pairingId, body) => {
      const attempt = ownedAttempt(caller, pairingId);
      if (isRefusal(attempt)) return attempt;
      const parsed = consoleConfirmSchema.safeParse(body);
      if (!parsed.success) return refusal("invalid", "a confirmation carries the SAS and a proof");
      const confirm: PairingStep = {
        kind: "console-confirm",
        from: pairingCallerOf(caller),
        ...parsed.data,
      };
      return step(attempt, confirm, actorOf(caller), "pair.confirm");
    },

    status: async (caller, pairingId) => {
      const attempt = ownedAttempt(caller, pairingId);
      return isRefusal(attempt) ? attempt : replyOf(attempt);
    },

    cancel: async (caller, pairingId) => {
      const attempt = ownedAttempt(caller, pairingId);
      if (isRefusal(attempt)) return attempt;
      return step(attempt, { kind: "cancel" }, actorOf(caller), "pair.cancel");
    },

    confirmOnDevice: async (pairingId, sas) => {
      const attempt = live(pairingId);
      if (attempt === undefined) return refusal("missing", "no pairing attempt has that id");
      const self = await options.self();
      const keeper: AuditActor = { stableId: self.stableId, userId: self.userId, tags: [] };
      return step(
        attempt,
        { kind: "target-confirm", by: "on-device", sas },
        keeper,
        "pair.confirm-on-device",
      );
    },

    endorse: async (endorser, pairingId, body) => {
      const owner = options.store.read().owner;
      const actor = actorOf(endorser.caller);
      if (
        endorser.pair.role !== "console" ||
        owner === null ||
        endorser.pair.peerUserId !== owner.userId
      ) {
        await audit(
          actor,
          "pair.endorse",
          { pairingId },
          { allowed: false, reason: "not-an-owner-console" },
        );
        return refusal("forbidden", "only a paired console of the owner may endorse a pairing");
      }
      const attempt = live(pairingId);
      if (attempt === undefined) return refusal("missing", "no pairing attempt has that id");
      const parsed = endorseSchema.safeParse(body);
      if (!parsed.success) return refusal("invalid", "an endorsement carries the SAS");
      return step(
        attempt,
        { kind: "target-confirm", by: "endorsement", sas: parsed.data.sas },
        actor,
        "pair.endorse",
      );
    },

    authenticate: async (request, caller) => {
      const verdict = await verified(request, caller);
      if (typeof verdict !== "string") return verdict;
      const attempted = { method: request.method, url: request.url };
      await audit(actorOf(caller), "request", attempted, { allowed: false, reason: verdict });
      return refusal("unauthenticated", verdict);
    },

    unpair: async (pairId, by) => {
      const records = options.store.read();
      const pair = records.pairs.find(({ id }) => id === pairId);
      if (pair === undefined) return undefined;
      options.store.write(withoutPair(records, pairId));
      await options.keys.remove(pairSecretName(pairId));
      emit({ type: "mesh.pair.removed", pairId, peerStableId: pair.peerStableId, by });
      return pair;
    },
  };
}

export function pairingCallerOf(caller: MeshCaller): PairingCaller {
  return {
    stableId: caller.node.stableId,
    userId: caller.human?.userId ?? null,
    tags: caller.node.tags,
  };
}

function identityMismatch(pair: PairRecord, caller: MeshCaller): AuthFailure | undefined {
  if (pair.peerStableId !== caller.node.stableId) return "node-mismatch";
  if (pair.peerUserId !== (caller.human?.userId ?? null)) return "human-mismatch";
  if (!sameTags(pair.peerTags, caller.node.tags)) return "tags-changed";
  return undefined;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n")
  );
}

function claimedBy(self: SelfIdentity, caller: PairingCaller, at: number): Owner | null {
  if (caller.userId === null) return null;
  return {
    tailnetId: self.tailnetId,
    userId: caller.userId,
    claimedAt: new Date(at).toISOString(),
  };
}

async function forgetReplacedSecrets(
  keys: KeyStore,
  before: readonly PairRecord[],
  after: readonly PairRecord[],
): Promise<void> {
  const kept = new Set(after.map(({ id }) => id));
  for (const { id } of before) if (!kept.has(id)) await keys.remove(pairSecretName(id));
}

function outcomeOf(attempt: TargetAttempt): { allowed: boolean; reason: string } {
  if (attempt.phase === "aborted") return { allowed: false, reason: attempt.abort ?? "aborted" };
  if (attempt.phase === "stored")
    return { allowed: true, reason: `paired by ${attempt.confirmation}` };
  return { allowed: true, reason: attempt.phase };
}

function replyOf(attempt: TargetAttempt): PairedReply {
  switch (attempt.phase) {
    case "aborted":
      return { state: "aborted", reason: attempt.abort ?? "aborted" };
    case "stored":
      return attempt.secret === null || attempt.transcript === null
        ? { state: "aborted", reason: "secret-lost" }
        : {
            state: "paired",
            proof: pairingProof(attempt.secret, "target-paired", attempt.transcript),
          };
    default:
      return { state: attempt.consoleConfirmed ? "awaiting-target" : "confirming" };
  }
}

function pendingOf(attempt: TargetAttempt): PendingPairing {
  return {
    pairingId: attempt.id,
    peerStableId: attempt.caller.stableId,
    peerUserId: attempt.caller.userId,
    role: attempt.role,
    caps: attempt.caps,
    confirmation: attempt.confirmation,
    phase: attempt.phase,
    sas: attempt.sas,
    expiresAt: new Date(attempt.expiresAt).toISOString(),
  };
}
