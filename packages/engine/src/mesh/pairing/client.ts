import {
  acceptHelloReply,
  beginAttempt,
  type ConsoleAttempt,
  confirmationOf,
  finishAttempt,
} from "./initiator.ts";
import type { DeviceKey, KeyStore } from "./keys.ts";
import { requestTarget, signedHeaders } from "./mac.ts";
import type { Confirmation, SelfIdentity } from "./machine.ts";
import type { PairRole } from "./sas.ts";
import {
  type PairRecord,
  type PairStore,
  pairSecretOf,
  savePairSecret,
  withPair,
} from "./store.ts";
import {
  type HelloReply,
  helloReplySchema,
  type PairedReply,
  pairedReplySchema,
  pairingPath,
  pairingPaths,
} from "./wire.ts";

export type MeshFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PairTarget {
  endpoint: string;
  stableId: string;
  userId?: string | null | undefined;
  tags?: readonly string[] | undefined;
}

export interface PairingPlan {
  role: PairRole;
  caps: readonly string[];
}

export interface BegunPairing {
  attemptId: string;
  sas: string;
  confirmation: Confirmation;
  expiresAt: string;
}

export interface PairingFailure {
  failed: string;
  detail: string;
}

export interface Completion {
  matches: boolean;
  claimCode?: string | undefined;
}

export type PairingResult = { paired: PairRecord } | PairingFailure;

export interface MeshClientOptions {
  deviceKey: DeviceKey;
  keys: KeyStore;
  store: PairStore;
  self(): Promise<SelfIdentity>;
  fetch?: MeshFetch | undefined;
  now?: (() => number) | undefined;
  pollMs?: number | undefined;
  confirmTimeoutMs?: number | undefined;
}

export interface MeshClient {
  begin(target: PairTarget, plan: PairingPlan): Promise<BegunPairing | PairingFailure>;
  complete(attemptId: string, completion: Completion): Promise<PairingResult>;
  pair(
    target: PairTarget,
    plan: PairingPlan & { claimCode?: string; compare(pairing: BegunPairing): Promise<boolean> },
  ): Promise<PairingResult>;
  send(pair: PairRecord, method: string, path: string, body?: unknown): Promise<Response>;
}

export const defaultPairingPollMs = 500;
export const defaultConfirmTimeoutMs = 120_000;

export function isPairingFailure(value: unknown): value is PairingFailure {
  return typeof value === "object" && value !== null && "failed" in value;
}

export function meshClient(options: MeshClientOptions): MeshClient {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const attempts = new Map<string, { attempt: ConsoleAttempt; target: PairTarget }>();

  const post = async (target: PairTarget, path: string, body: unknown): Promise<Response> =>
    send(new URL(path, target.endpoint).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const settledReply = async (target: PairTarget, attemptId: string, first: PairedReply) => {
    const deadline = now() + (options.confirmTimeoutMs ?? defaultConfirmTimeoutMs);
    let reply = first;
    while (reply.state === "awaiting-target" && now() < deadline) {
      await delay(options.pollMs ?? defaultPairingPollMs);
      const polled = await send(
        new URL(pairingPath(pairingPaths.attempt, attemptId), target.endpoint).href,
        {
          method: "GET",
        },
      );
      reply = await pairedReplyOf(polled);
    }
    return reply;
  };

  const remember = async (
    attempt: ConsoleAttempt,
    target: PairTarget,
    confirmation: Confirmation,
  ) => {
    const reply = attempt.reply;
    if (attempt.secret === null || reply === null) return undefined;
    const pair: PairRecord = {
      id: reply.pairingId,
      peerStableId: target.stableId,
      peerUserId: target.userId ?? null,
      peerTags: [...(target.tags ?? [])],
      peerDeviceKey: reply.deviceKey,
      role: "target",
      caps: [...attempt.caps],
      endpoint: target.endpoint,
      createdAt: new Date(now()).toISOString(),
      confirmedBy: confirmation,
    };
    await savePairSecret(options.keys, pair.id, attempt.secret);
    options.store.write(withPair(options.store.read(), pair));
    return pair;
  };

  const client: MeshClient = {
    begin: async (target, plan) => {
      const self = await options.self();
      const { attempt, hello } = beginAttempt({
        ...plan,
        selfStableId: self.stableId,
        targetStableId: target.stableId,
        deviceKey: options.deviceKey.publicKey,
      });
      const greeted = await post(target, pairingPaths.hello, hello);
      const reply = await helloReplyOf(greeted);
      if (isPairingFailure(reply)) return reply;
      const revealed = acceptHelloReply(attempt, reply);
      if (revealed.phase === "aborted" || revealed.sas === null) {
        return {
          failed: revealed.abort ?? "rejected",
          detail: "the target is not the node discovery named",
        };
      }
      const path = pairingPath(pairingPaths.reveal, reply.pairingId);
      const revealReply = await pairedReplyOf(await post(target, path, { nonce: attempt.nonce }));
      if (revealReply.state !== "confirming") {
        return {
          failed: revealReply.reason ?? revealReply.state,
          detail: "the target refused the reveal",
        };
      }
      attempts.set(reply.pairingId, { attempt: revealed, target });
      return {
        attemptId: reply.pairingId,
        sas: revealed.sas,
        confirmation: reply.confirmation,
        expiresAt: reply.expiresAt,
      };
    },

    complete: async (attemptId, completion) => {
      const held = attempts.get(attemptId);
      if (held === undefined)
        return { failed: "missing", detail: "no pairing attempt has that id" };
      attempts.delete(attemptId);
      const { attempt, target } = held;
      if (!completion.matches) {
        await send(new URL(pairingPath(pairingPaths.attempt, attemptId), target.endpoint).href, {
          method: "DELETE",
        });
        return { failed: "rejected", detail: "the keeper saw different codes" };
      }
      const confirmation = confirmationOf(attempt, completion.claimCode);
      if (confirmation === undefined)
        return { failed: "out-of-order", detail: "nothing to confirm" };
      const path = pairingPath(pairingPaths.confirm, attemptId);
      const reply = await settledReply(
        target,
        attemptId,
        await pairedReplyOf(await post(target, path, confirmation)),
      );
      if (reply.state !== "paired" || reply.proof === undefined) {
        return {
          failed: reply.reason ?? reply.state,
          detail: "the target did not complete the pairing",
        };
      }
      const finished = finishAttempt(attempt, reply.proof);
      if (finished.phase !== "paired")
        return {
          failed: finished.abort ?? "bad-proof",
          detail: "the target could not prove the pair key",
        };
      const pair = await remember(finished, target, attempt.reply?.confirmation ?? "on-device");
      return pair === undefined
        ? { failed: "secret-lost", detail: "the pair key is gone" }
        : { paired: pair };
    },

    pair: async (target, plan) => {
      const begun = await client.begin(target, plan);
      if (isPairingFailure(begun)) return begun;
      return client.complete(begun.attemptId, {
        matches: await plan.compare(begun),
        claimCode: plan.claimCode,
      });
    },

    send: async (pair, method, path, body) => {
      if (pair.endpoint === null) throw new Error(`pair ${pair.id} has no endpoint to reach`);
      const secret = await pairSecretOf(options.keys, pair.id);
      if (secret === undefined) throw new Error(`pair ${pair.id} has no key`);
      const url = new URL(path, pair.endpoint).href;
      const text = body === undefined ? "" : JSON.stringify(body);
      const headers = signedHeaders(
        pair.id,
        secret,
        { method, target: requestTarget(url), body: text },
        now(),
      );
      return send(url, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(method !== "GET" && method !== "HEAD" && { body: text }),
      });
    },
  };
  return client;
}

async function helloReplyOf(response: Response): Promise<HelloReply | PairingFailure> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    return {
      failed: errorOf(body) ?? `http-${response.status}`,
      detail: "the target refused the hello",
    };
  const parsed = helloReplySchema.safeParse(body);
  return parsed.success
    ? parsed.data
    : { failed: "invalid", detail: "the target's hello reply is malformed" };
}

async function pairedReplyOf(response: Response): Promise<PairedReply> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = pairedReplySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  return { state: "aborted", reason: errorOf(body) ?? `http-${response.status}` };
}

function errorOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { error } = body as { error?: unknown };
  return typeof error === "string" ? error : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
