import { describe, expect, it } from "vitest";
import type { Tool } from "../../tools.ts";
import { type AuditRow, memoryAuditLog, verifyAuditChain } from "../audit/log.ts";
import type { MeshClient, MeshFetch } from "../pairing/client.ts";
import { type DeviceKey, loadDeviceKey, memoryKeyStore } from "../pairing/keys.ts";
import type { SelfIdentity } from "../pairing/machine.ts";
import { type Authenticated, isRefusal, type PairingService } from "../pairing/service.ts";
import { memoryPairStore, type PairRecord, type PairStore, withoutPair } from "../pairing/store.ts";
import {
  callerOf,
  hostNode,
  houseNode,
  keeperId,
  selfOf,
  tailnetId,
} from "../pairing/testing/identities.ts";
import { ledgerGate, type MeshAsk } from "./gate.ts";
import type { Grant } from "./grant.ts";
import type { MeshGate } from "./remote-call.ts";
import { type GrantEvent, type GrantService, grantService } from "./service.ts";
import { type GrantStore, memoryGrantStore } from "./store.ts";

const t0 = Date.parse("2026-11-05T12:00:00Z");
const hour = 60 * 60_000;

function pairing(store: PairStore): Pick<PairingService, "pairs" | "owner" | "unpair"> {
  return {
    pairs: () => store.read().pairs,
    owner: () => store.read().owner,
    unpair: async (pairId) => {
      const pair = store.read().pairs.find(({ id }) => id === pairId);
      store.write(withoutPair(store.read(), pairId));
      return pair;
    },
  };
}

function record(peer: typeof houseNode, key: DeviceKey, role: PairRecord["role"]): PairRecord {
  return {
    id: "pair-house-host",
    peerStableId: peer.stableId,
    peerUserId: peer.userId,
    peerTags: [],
    peerDeviceKey: key.publicKey,
    role,
    caps: [],
    endpoint: role === "target" ? "http://100.88.77.66:47800" : null,
    createdAt: new Date(t0).toISOString(),
    confirmedBy: "on-device",
  };
}

const echoTool: Tool = {
  name: "bash",
  description: "echo for tests",
  parameters: { type: "object" },
  mutates: true,
  execute: async (args) => `ran ${(args as { command: string }).command}`,
};

interface Side {
  grants: GrantService;
  events: GrantEvent[];
  rows(): Promise<AuditRow[]>;
  store: GrantStore;
  pairs: PairStore;
}

interface SideOptions {
  self: SelfIdentity;
  key: DeviceKey;
  pairs: PairStore;
  gate?: MeshGate | undefined;
  client?: Pick<MeshClient, "send"> | undefined;
  fetch?: MeshFetch | undefined;
  store?: GrantStore | undefined;
}

function side(options: SideOptions): Side {
  const audit = memoryAuditLog();
  const events: GrantEvent[] = [];
  const store = options.store ?? memoryGrantStore();
  const grants = grantService({
    deviceKey: options.key,
    pairing: pairing(options.pairs),
    client: options.client ?? { send: async () => new Response(null, { status: 503 }) },
    store,
    audit,
    gate: options.gate ?? ledgerGate({ root: "/srv/work", tools: () => [echoTool] }),
    self: async () => options.self,
    fetch: options.fetch,
    now: () => t0,
    onEvent: (event) => events.push(event),
  });
  return { grants, events, rows: () => audit.rows(), store, pairs: options.pairs };
}

async function mesh(options: { ask?: MeshAsk; gate?: MeshGate; targetStore?: GrantStore } = {}) {
  const houseKey = await loadDeviceKey(memoryKeyStore());
  const hostKey = await loadDeviceKey(memoryKeyStore());
  const owner = { tailnetId, userId: keeperId, claimedAt: new Date(t0).toISOString() };
  const hostPairs = memoryPairStore({ owner, pairs: [record(houseNode, houseKey, "console")] });
  const housePairs = memoryPairStore({ owner: null, pairs: [record(hostNode, hostKey, "target")] });
  const asHouse = (body: string): Authenticated => ({
    pair: hostPairs.read().pairs[0] as PairRecord,
    caller: callerOf(houseNode),
    body,
  });
  const host = side({
    self: selfOf(hostNode),
    key: hostKey,
    pairs: hostPairs,
    gate:
      options.gate ?? ledgerGate({ root: "/srv/work", tools: () => [echoTool], ask: options.ask }),
    store: options.targetStore,
  });
  const delivered: unknown[] = [];
  const house = side({
    self: selfOf(houseNode),
    key: houseKey,
    pairs: housePairs,
    client: {
      send: async (_pair, _method, _path, body) => {
        const installed = await host.grants.install(asHouse(JSON.stringify(body)));
        return Response.json(installed, { status: isRefusal(installed) ? 403 : 201 });
      },
    },
    fetch: async (_url, init) => {
      const revocation: unknown = JSON.parse(String(init.body));
      delivered.push(revocation);
      const applied = await host.grants.applyRevocation(callerOf(houseNode), revocation);
      return Response.json(applied, { status: isRefusal(applied) ? 403 : 200 });
    },
  });
  const call = (grantId: string, command: string, extra: Record<string, unknown> = {}) =>
    host.grants.call(
      asHouse(
        JSON.stringify({
          creature: "pip",
          grantId,
          call: { callId: `c-${command}`, name: "bash", arguments: { command } },
          ...extra,
        }),
      ),
    );
  return { house, host, call, delivered, hostPairs, houseKey };
}

const execEcho = {
  subject: { creature: "pip", node: houseNode.stableId },
  target: hostNode.stableId,
  caps: [{ kind: "exec", commands: ["echo"] }],
  expiresAt: new Date(t0 + hour).toISOString(),
};

async function issued(house: Side): Promise<Grant> {
  const grant = await house.grants.issue(execEcho);
  if (isRefusal(grant)) throw new Error(grant.error);
  return grant;
}

describe("grantService", () => {
  it("issues a signed grant that the target verifies, installs and renders into creature rules", async () => {
    const { house, host } = await mesh();
    const grant = await issued(house);
    expect(house.grants.list().issued).toEqual([grant]);
    expect(host.grants.list().installed).toEqual([grant]);
    expect(host.grants.rulesFor({ creature: "pip", node: houseNode.stableId })).toEqual([
      { action: "bash", resource: "echo *", effect: "allow" },
    ]);
    expect(host.grants.rulesFor({ creature: "other", node: houseNode.stableId })).toEqual([]);
    expect(host.events).toContainEqual({ type: "mesh.grant.installed", grant });
  });

  it("runs a covered call through the gate, puts one envelope on the bus and audits it", async () => {
    const { house, host, call } = await mesh();
    const grant = await issued(house);
    expect(await call(grant.id, "echo hi")).toEqual({
      callId: "c-echo hi",
      verdict: "allowed",
      output: "ran echo hi",
      isError: false,
      reason: "allowed by the grant's rules",
    });
    expect(host.events.filter(({ type }) => type === "mesh.tool.call")).toEqual([
      expect.objectContaining({
        origin: { kind: "mesh", creature: "pip", node: houseNode.stableId },
        grantId: grant.id,
        call: {
          type: "tool-call",
          callId: "c-echo hi",
          name: "bash",
          arguments: { command: "echo hi" },
        },
      }),
    ]);
    const rows = await host.rows();
    expect(rows.at(-1)).toMatchObject({
      actorStableID: houseNode.stableId,
      targetStableID: hostNode.stableId,
      capability: "exec",
      decision: "allow",
    });
    expect(verifyAuditChain(rows)).toMatchObject({ intact: true });
  });

  it("asks the keeper for an exec the grant does not cover and denies without an answer", async () => {
    const asked: string[] = [];
    const { house, host, call } = await mesh({
      ask: async (envelope) => {
        asked.push(String((envelope.call.arguments as { command: string }).command));
        return false;
      },
    });
    const grant = await issued(house);
    expect(await call(grant.id, "ls -la")).toMatchObject({
      verdict: "denied",
      reason: "the keeper declined",
    });
    expect(asked).toEqual(["ls -la"]);
    expect((await host.rows()).at(-1)).toMatchObject({ capability: "exec", decision: "deny" });
    const unattended = await mesh();
    const quiet = await issued(unattended.house);
    expect(await unattended.call(quiet.id, "ls")).toMatchObject({
      reason: "asks are not served for mesh calls",
    });
  });

  it.each([
    ["an unknown grant", "grant-nope", {}, /^no-grant/],
    ["a call past the hop limit", undefined, { hop: 5 }, /^hop-limit/],
    ["another creature", undefined, { creature: "otter" }, /^not-the-subject/],
  ] as const)("refuses %s before the gate", async (_name, grantId, extra, reason) => {
    const { house, host, call } = await mesh();
    const grant = await issued(house);
    expect(await call(grantId ?? grant.id, "echo hi", extra)).toMatchObject({
      verdict: "denied",
      reason: expect.stringMatching(reason),
    });
    expect(host.events.some(({ type }) => type === "mesh.tool.call")).toBe(false);
    expect((await host.rows()).at(-1)).toMatchObject({ decision: "deny", capability: "tool" });
  });

  it("refuses a tool the grant gives no capability over", async () => {
    const { house, host } = await mesh();
    const grant = await issued(house);
    const read = await host.grants.call({
      pair: host.pairs.read().pairs[0] as PairRecord,
      caller: callerOf(houseNode),
      body: JSON.stringify({
        creature: "pip",
        grantId: grant.id,
        call: { callId: "r", name: "read", arguments: { path: "a" } },
      }),
    });
    expect(read).toMatchObject({
      verdict: "denied",
      reason: expect.stringMatching(/^outside-grant/),
    });
  });

  it("revokes on the console, pushes a signed revocation and the target denies at once", async () => {
    const { house, host, call, delivered } = await mesh();
    const grant = await issued(house);
    const revocation = await house.grants.revoke(grant.id);
    expect(revocation).toMatchObject({ kind: "grant", id: grant.id, issuer: houseNode.stableId });
    expect(delivered).toEqual([revocation]);
    expect(house.grants.list().issued).toEqual([]);
    expect(host.grants.list().installed).toEqual([]);
    expect(await call(grant.id, "echo hi")).toMatchObject({
      verdict: "denied",
      reason: expect.stringMatching(/^no-grant/),
    });
    expect(host.grants.rulesFor(grant.subject)).toEqual([]);
    expect(house.store.read().outbox).toEqual([]);
  });

  it("refuses to reinstall a revoked grant", async () => {
    const { house, host } = await mesh();
    const grant = await issued(house);
    await house.grants.revoke(grant.id);
    const again = await host.grants.install({
      pair: host.pairs.read().pairs[0] as PairRecord,
      caller: callerOf(houseNode),
      body: JSON.stringify(grant),
    });
    expect(again).toEqual({ refused: "forbidden", error: "revoked" });
  });

  it("keeps an undelivered revocation and retries it", async () => {
    const { house, host, call, houseKey } = await mesh();
    const grant = await issued(house);
    let reachable = false;
    const outbox = side({
      self: selfOf(houseNode),
      key: houseKey,
      pairs: house.pairs,
      store: house.store,
      fetch: async (_url, init) => {
        if (!reachable) throw new Error("connect ECONNREFUSED");
        const applied = await host.grants.applyRevocation(
          callerOf(houseNode),
          JSON.parse(String(init.body)),
        );
        return Response.json(applied);
      },
    });
    await outbox.grants.revoke(grant.id);
    expect(outbox.store.read().outbox).toHaveLength(1);
    expect(outbox.events).toContainEqual(
      expect.objectContaining({ type: "mesh.revocation.undelivered", attempts: 1 }),
    );
    reachable = true;
    expect(await outbox.grants.flushRevocations()).toEqual({ delivered: 1, pending: 0 });
    expect(outbox.store.read().outbox).toEqual([]);
    expect(await call(grant.id, "echo hi")).toMatchObject({ verdict: "denied" });
  });

  it("denies every call once the issuing console is unpaired", async () => {
    const { house, call, hostPairs } = await mesh();
    const grant = await issued(house);
    hostPairs.write(withoutPair(hostPairs.read(), "pair-house-host"));
    expect(await call(grant.id, "echo hi")).toMatchObject({
      reason: "grant-invalid: unknown-issuer",
    });
  });

  it("never writes a screen-control grant to durable storage", async () => {
    const targetStore = memoryGrantStore();
    const { house, host } = await mesh({ targetStore });
    const grant = await house.grants.issue({
      ...execEcho,
      caps: [{ kind: "screen:control" }],
      expiresAt: new Date(t0 + 10 * 60_000).toISOString(),
    });
    expect(isRefusal(grant)).toBe(false);
    expect(host.grants.list().installed).toHaveLength(1);
    expect(targetStore.read().installed).toEqual([]);
  });

  it("refuses a draft for a node this console is not paired with, or for itself", async () => {
    const { house } = await mesh();
    expect(await house.grants.issue({ ...execEcho, target: "nOtherCNTRL" })).toMatchObject({
      refused: "missing",
    });
    expect(await house.grants.issue({ ...execEcho, target: houseNode.stableId })).toMatchObject({
      refused: "invalid",
    });
    expect(await house.grants.issue({ ...execEcho, caps: [] })).toMatchObject({
      refused: "invalid",
    });
  });
});
