import type { PermissionRule } from "@keywork/shared";
import { z } from "zod";
import { actorOf } from "../audit/admissions.ts";
import type { AuditActor, AuditDecision, AuditLog, AuditRow } from "../audit/log.ts";
import { screenAuditEntry, screenAuditRecordSchema } from "../audit/screen.ts";
import type { MeshCaller } from "../listener/admission.ts";
import type { MeshClient, MeshFetch } from "../pairing/client.ts";
import type { DeviceKey } from "../pairing/keys.ts";
import type { SelfIdentity } from "../pairing/machine.ts";
import {
  type Authenticated,
  type PairingService,
  type Refusal,
  refusal,
} from "../pairing/service.ts";
import { type CapKind, capOfTool, capSchema } from "./caps.ts";
import {
  type ChainContext,
  type ChainFailure,
  creatureSlug,
  type Grant,
  type GrantSubject,
  isLive,
  signGrant,
  verifyGrantChain,
} from "./grant.ts";
import {
  type GateOutcome,
  type MeshGate,
  type MeshOrigin,
  type MeshToolEnvelope,
  maxMeshHops,
  type RemoteCallRequest,
  type RemoteCallResult,
  remoteCallSchema,
  toolCallOf,
} from "./remote-call.ts";
import {
  meshRevocationsPath,
  type Revocation,
  signRevocation,
  verifyRevocation,
} from "./revocation.ts";
import { subjectRules } from "./rules.ts";
import { durableGrants, type GrantRecords, type GrantStore, prunedGrants } from "./store.ts";

export const meshGrantsPath = "/mesh/grants";

export type GrantRevoker = "keeper" | "revocation";

export type GrantEvent =
  | { type: "mesh.grant.issued"; grant: Grant }
  | { type: "mesh.grant.installed"; grant: Grant }
  | { type: "mesh.grant.refused"; issuer: string; reason: ChainFailure }
  | { type: "mesh.grant.revoked"; grantId: string; by: GrantRevoker }
  | { type: "mesh.revocation.undelivered"; revocation: Revocation; attempts: number; error: string }
  | MeshToolEnvelope
  | { type: "mesh.tool.refused"; origin: MeshOrigin; grantId: string; tool: string; reason: string }
  | {
      type: "mesh.tool.finished";
      origin: MeshOrigin;
      grantId: string;
      callId: string;
      outcome: GateOutcome;
    };

export interface GrantServiceOptions {
  deviceKey: DeviceKey;
  pairing: Pick<PairingService, "pairs" | "owner" | "unpair">;
  client: Pick<MeshClient, "send">;
  store: GrantStore;
  audit: AuditLog;
  gate: MeshGate;
  self(): Promise<SelfIdentity>;
  fetch?: MeshFetch | undefined;
  now?: (() => number) | undefined;
  onEvent?: ((event: GrantEvent) => void) | undefined;
}

export interface GrantList {
  installed: Grant[];
  issued: Grant[];
}

export interface RevocationFlush {
  delivered: number;
  pending: number;
}

export interface GrantService {
  list(): GrantList;
  rulesFor(subject: GrantSubject): PermissionRule[];
  issue(draft: unknown): Promise<Grant | Refusal>;
  revoke(grantId: string): Promise<Revocation | Refusal>;
  forgetPair(pairId: string): Promise<Revocation | Refusal>;
  install(request: Authenticated): Promise<Grant | Refusal>;
  applyRevocation(caller: MeshCaller, body: unknown): Promise<{ revoked: string } | Refusal>;
  call(request: Authenticated): Promise<RemoteCallResult | Refusal>;
  recordScreen(record: unknown): Promise<AuditRow | Refusal>;
  flushRevocations(): Promise<RevocationFlush>;
}

export const grantDraftSchema = z
  .object({
    subject: z
      .object({ creature: z.string().regex(creatureSlug), node: z.string().min(1) })
      .strict(),
    target: z.string().min(1),
    caps: z.array(capSchema).min(1).max(16),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export function grantService(options: GrantServiceOptions): GrantService {
  const now = options.now ?? Date.now;
  const post = options.fetch ?? fetch;
  const emit = (event: GrantEvent) => options.onEvent?.(event);
  let records = prunedGrants(options.store.read(), now());

  const update = (change: (held: GrantRecords) => GrantRecords) => {
    records = change(prunedGrants(records, now()));
    options.store.write(durableGrants(records));
  };

  const audit = async (
    actor: AuditActor,
    capability: string,
    request: unknown,
    decision: AuditDecision,
    reason: string,
  ) => {
    const self = await options.self();
    await options.audit.append({
      actor,
      target: self.stableId,
      capability,
      request,
      decision,
      reason,
    });
  };

  const keeper = async (): Promise<AuditActor> => {
    const self = await options.self();
    return { stableId: self.stableId, userId: self.userId, tags: [] };
  };

  const chainContext = async (): Promise<ChainContext> => {
    const self = await options.self();
    const revoked = new Set(records.revoked.map(({ id }) => id));
    return {
      self: self.stableId,
      owner: options.pairing.owner(),
      pairs: options.pairing.pairs(),
      now: now(),
      revoked: (id) => revoked.has(id),
    };
  };

  const pairOfTarget = (target: string) =>
    options.pairing
      .pairs()
      .find(({ role, peerStableId }) => role === "target" && peerStableId === target);

  const queueRevocation = async (revocation: Revocation, endpoint: string | null) => {
    if (endpoint !== null) {
      update((held) => ({
        ...held,
        outbox: [...held.outbox, { revocation, endpoint, attempts: 0 }],
      }));
    }
    await service.flushRevocations();
  };

  const refuseCall = async (
    request: Authenticated,
    call: RemoteCallRequest,
    reason: string,
  ): Promise<RemoteCallResult> => {
    const origin = originOf(call, request.caller);
    emit({
      type: "mesh.tool.refused",
      origin,
      grantId: call.grantId,
      tool: call.call.name,
      reason,
    });
    await audit(actorOf(request.caller), "tool", auditedCall(call), "deny", reason);
    return { callId: call.call.callId, verdict: "denied", output: "", isError: true, reason };
  };

  const callableGrant = async (
    request: Authenticated,
    call: RemoteCallRequest,
  ): Promise<{ grant: Grant; cap: CapKind } | string> => {
    if (call.hop > maxMeshHops) return `hop-limit: ${call.hop} hops is more than ${maxMeshHops}`;
    const held = records.installed.find(({ id }) => id === call.grantId);
    if (held === undefined) return "no-grant: this node holds no live grant with that id";
    const chain = verifyGrantChain(held, await chainContext());
    if ("failure" in chain) return `grant-invalid: ${chain.failure}`;
    const { subject } = chain.valid;
    if (subject.node !== request.pair.peerStableId || subject.creature !== call.creature) {
      return "not-the-subject: the grant names another creature or node";
    }
    const cap = capOfTool(chain.valid.caps, call.call.name);
    if (cap === undefined)
      return `outside-grant: the grant gives no capability over ${call.call.name}`;
    return { grant: chain.valid, cap: cap.kind };
  };

  const service: GrantService = {
    list: () => {
      const live = prunedGrants(records, now());
      return { installed: live.installed, issued: live.issued };
    },

    rulesFor: (subject) =>
      subjectRules(
        records.installed.filter(
          (grant) =>
            isLive(grant, now()) &&
            grant.subject.creature === subject.creature &&
            grant.subject.node === subject.node,
        ),
      ),

    issue: async (draft) => {
      const parsed = grantDraftSchema.safeParse(draft);
      if (!parsed.success)
        return refusal("invalid", parsed.error.issues[0]?.message ?? "not a grant");
      const self = await options.self();
      if (parsed.data.target === self.stableId) {
        return refusal("invalid", "a console's own creatures use its own gate, not a mesh grant");
      }
      const pair = pairOfTarget(parsed.data.target);
      if (pair === undefined)
        return refusal("missing", "this console is not paired with that node");
      const grant = signGrant(parsed.data, self.stableId, options.deviceKey, now());
      const response = await options.client.send(pair, "POST", meshGrantsPath, grant);
      if (!response.ok) {
        const reason = await errorText(response);
        await audit(await keeper(), "grant.issue", grant, "deny", reason);
        return refusal("forbidden", `the target refused the grant: ${reason}`);
      }
      update((held) => ({ ...held, issued: [...held.issued, grant] }));
      await audit(await keeper(), "grant.issue", grant, "allow", `issued ${grant.id}`);
      emit({ type: "mesh.grant.issued", grant });
      return grant;
    },

    revoke: async (grantId) => {
      const issued = records.issued.find(({ id }) => id === grantId);
      const installed = records.installed.find(({ id }) => id === grantId);
      const grant = issued ?? installed;
      if (grant === undefined) return refusal("missing", "no live grant has that id");
      const self = await options.self();
      update((held) => revokedLocally(held, grant.id, grant.expiresAt));
      await audit(await keeper(), "grant.revoke", { grantId }, "allow", "revoked by the keeper");
      emit({ type: "mesh.grant.revoked", grantId, by: "keeper" });
      const revocation = signRevocation(
        { kind: "grant", id: grantId, target: grant.target },
        self.stableId,
        options.deviceKey,
        now(),
      );
      if (issued !== undefined)
        await queueRevocation(revocation, pairOfTarget(grant.target)?.endpoint ?? null);
      return revocation;
    },

    forgetPair: async (pairId) => {
      const pair = await options.pairing.unpair(pairId, "keeper");
      if (pair === undefined) return refusal("missing", "no pair has that id");
      const self = await options.self();
      await audit(await keeper(), "pair.remove", { pairId }, "allow", "unpaired by the keeper");
      const revocation = signRevocation(
        { kind: "pair", id: pairId, target: pair.peerStableId },
        self.stableId,
        options.deviceKey,
        now(),
      );
      if (pair.role === "target") await queueRevocation(revocation, pair.endpoint);
      return revocation;
    },

    install: async (request) => {
      const chain = verifyGrantChain(parsedJson(request.body), await chainContext());
      if ("failure" in chain) {
        await audit(actorOf(request.caller), "grant.install", request.body, "deny", chain.failure);
        emit({
          type: "mesh.grant.refused",
          issuer: request.pair.peerStableId,
          reason: chain.failure,
        });
        return refusal("forbidden", chain.failure);
      }
      const grant = chain.valid;
      update((held) => ({
        ...held,
        installed: [...withoutGrant(held, grant.id).installed, grant],
      }));
      await audit(
        actorOf(request.caller),
        "grant.install",
        grant,
        "allow",
        `installed ${grant.id}`,
      );
      emit({ type: "mesh.grant.installed", grant });
      return grant;
    },

    applyRevocation: async (caller, body) => {
      const verdict = verifyRevocation(body, await chainContext());
      if ("failure" in verdict) {
        await audit(actorOf(caller), "revocation", body, "deny", verdict.failure);
        return refusal("forbidden", verdict.failure);
      }
      const revocation = verdict.valid;
      if (revocation.kind === "pair") {
        await options.pairing.unpair(revocation.id, "revocation");
      } else {
        const grant = records.installed.find(({ id }) => id === revocation.id);
        const until = grant?.expiresAt ?? farFuture(now());
        update((held) => revokedLocally(held, revocation.id, until));
        emit({ type: "mesh.grant.revoked", grantId: revocation.id, by: "revocation" });
      }
      await audit(
        actorOf(caller),
        "revocation",
        revocation,
        "allow",
        `revoked ${revocation.kind} ${revocation.id}`,
      );
      return { revoked: revocation.id };
    },

    call: async (request) => {
      const parsed = remoteCallSchema.safeParse(parsedJson(request.body));
      if (!parsed.success)
        return refusal("invalid", parsed.error.issues[0]?.message ?? "not a tool call");
      const call = parsed.data;
      const callable = await callableGrant(request, call);
      if (typeof callable === "string") return refuseCall(request, call, callable);
      const origin = originOf(call, request.caller);
      const envelope: MeshToolEnvelope = {
        type: "mesh.tool.call",
        origin,
        grantId: callable.grant.id,
        call: toolCallOf(call.call),
        rules: service.rulesFor(origin),
      };
      emit(envelope);
      const outcome = await options.gate.run(envelope);
      const decision = outcome.verdict === "allowed" ? "allow" : "deny";
      await audit(
        actorOf(request.caller),
        callable.cap,
        auditedCall(call),
        decision,
        outcome.reason,
      );
      emit({
        type: "mesh.tool.finished",
        origin,
        grantId: callable.grant.id,
        callId: call.call.callId,
        outcome,
      });
      return { callId: call.call.callId, ...outcome };
    },

    recordScreen: async (record) => {
      const parsed = screenAuditRecordSchema.safeParse(record);
      if (!parsed.success)
        return refusal("invalid", parsed.error.issues[0]?.message ?? "not a screen audit record");
      const self = await options.self();
      return options.audit.append(screenAuditEntry(parsed.data, self.stableId));
    },

    flushRevocations: async () => {
      const attempts = await Promise.all(
        records.outbox.map(async (item) => ({ item, delivery: await deliver(post, item) })),
      );
      for (const { item, delivery } of attempts) {
        if (delivery.error === undefined) continue;
        emit({
          type: "mesh.revocation.undelivered",
          revocation: item.revocation,
          attempts: item.attempts + 1,
          error: delivery.error,
        });
      }
      const settled = new Set(
        attempts.filter(({ delivery }) => delivery.delivered).map(({ item }) => item),
      );
      const retried = new Set(attempts.map(({ item }) => item));
      update((held) => ({
        ...held,
        outbox: held.outbox
          .filter((item) => !settled.has(item))
          .map((item) => (retried.has(item) ? { ...item, attempts: item.attempts + 1 } : item)),
      }));
      return { delivered: settled.size, pending: attempts.length - settled.size };
    },
  };
  return service;
}

interface Delivery {
  delivered: boolean;
  error?: string;
}

export function retryRevocations(
  service: Pick<GrantService, "flushRevocations">,
  intervalMs: number,
): () => void {
  const timer = setInterval(
    () => void service.flushRevocations().catch(() => undefined),
    intervalMs,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

function originOf(call: RemoteCallRequest, caller: MeshCaller): MeshOrigin {
  return { kind: "mesh", creature: call.creature, node: caller.node.stableId };
}

function auditedCall(call: RemoteCallRequest): unknown {
  return {
    creature: call.creature,
    grantId: call.grantId,
    tool: call.call.name,
    arguments: call.call.arguments,
  };
}

function withoutGrant(records: GrantRecords, grantId: string): GrantRecords {
  const other = ({ id }: Grant) => id !== grantId;
  return {
    ...records,
    installed: records.installed.filter(other),
    issued: records.issued.filter(other),
  };
}

function revokedLocally(records: GrantRecords, grantId: string, until: string): GrantRecords {
  const revoked = records.revoked.filter(({ id }) => id !== grantId);
  return { ...withoutGrant(records, grantId), revoked: [...revoked, { id: grantId, until }] };
}

async function deliver(post: MeshFetch, item: GrantRecords["outbox"][number]): Promise<Delivery> {
  try {
    const response = await post(new URL(meshRevocationsPath, item.endpoint).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item.revocation),
    });
    if (response.ok) return { delivered: true };
    const error = `the node answered ${response.status}: ${await errorText(response)}`;
    return { delivered: response.status < 500, error };
  } catch (cause) {
    return { delivered: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function errorText(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return `http ${response.status}`;
}

function farFuture(now: number): string {
  return new Date(now + 366 * 24 * 60 * 60_000).toISOString();
}
