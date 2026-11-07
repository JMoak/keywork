import { describe, expect, it } from "vitest";
import { type AuditRow, memoryAuditLog, verifyAuditChain } from "../audit/log.ts";
import type { MeshCaller } from "../listener/admission.ts";
import { issueClaimCode } from "./claim-code.ts";
import { acceptHelloReply, beginAttempt, confirmationOf, finishAttempt } from "./initiator.ts";
import { type KeyStore, loadDeviceKey, memoryKeyStore } from "./keys.ts";
import { signedHeaders } from "./mac.ts";
import type { PairRole } from "./sas.ts";
import {
  type Authenticated,
  type AuthFailure,
  isRefusal,
  type PairingEvent,
  type PairingService,
  pairingService,
} from "./service.ts";
import { memoryPairStore, type PairStore, pairSecretOf } from "./store.ts";
import {
  callerOf,
  hostNode,
  houseNode,
  keeperId,
  selfOf,
  strangerId,
  type TestNode,
  taggedNode,
  tailnetId,
} from "./testing/identities.ts";

interface Target {
  service: PairingService;
  store: PairStore;
  keys: KeyStore;
  events: PairingEvent[];
  rows(): Promise<AuditRow[]>;
}

async function target(
  options: { headless?: boolean; store?: PairStore; now?: () => number } = {},
): Promise<Target> {
  const keys = memoryKeyStore();
  const store = options.store ?? memoryPairStore();
  const audit = memoryAuditLog();
  const events: PairingEvent[] = [];
  const service = pairingService({
    deviceKey: await loadDeviceKey(keys),
    keys,
    store,
    audit,
    self: async () => selfOf(hostNode),
    headless: options.headless,
    now: options.now,
    onEvent: (event) => events.push(event),
  });
  return { service, store, keys, events, rows: () => audit.rows() };
}

async function greet(
  service: PairingService,
  from: TestNode,
  role: PairRole = "console",
  userId = from.userId,
) {
  const consoleKey = await loadDeviceKey(memoryKeyStore());
  const { attempt, hello } = beginAttempt({
    role,
    caps: ["exec"],
    selfStableId: from.stableId,
    targetStableId: hostNode.stableId,
    deviceKey: consoleKey.publicKey,
  });
  const caller = callerOf(from, userId);
  const reply = await service.hello(caller, hello);
  return { attempt, caller, reply };
}

async function revealed(
  service: PairingService,
  from: TestNode = houseNode,
  role: PairRole = "console",
) {
  const { attempt, caller, reply } = await greet(service, from, role);
  if (isRefusal(reply)) throw new Error(reply.error);
  const consoleSide = acceptHelloReply(attempt, reply);
  expect(await service.reveal(caller, reply.pairingId, { nonce: attempt.nonce })).toEqual({
    state: "confirming",
  });
  return { consoleSide, caller, pairingId: reply.pairingId, confirmation: reply.confirmation };
}

describe("pairingService", () => {
  it("pairs the owner's console after the SAS is confirmed on the device and on the console", async () => {
    const node = await target();
    expect(node.service.claimState()).toBe("unclaimed");
    const { consoleSide, caller, pairingId, confirmation } = await revealed(node.service);
    expect(confirmation).toBe("on-device");
    const shown = node.events.find((event) => event.type === "mesh.pairing.confirming");
    expect(shown).toMatchObject({ pairing: { pairingId, sas: consoleSide.sas } });
    expect(await node.service.confirmOnDevice(pairingId, consoleSide.sas ?? "")).toEqual({
      state: "confirming",
    });
    const reply = await node.service.confirm(caller, pairingId, confirmationOf(consoleSide));
    expect(reply).toMatchObject({ state: "paired" });
    if (isRefusal(reply) || reply.proof === undefined) throw new Error("not paired");
    expect(finishAttempt(consoleSide, reply.proof).phase).toBe("paired");
    expect(node.service.claimState()).toBe("claimed");
    expect(node.service.owner()).toMatchObject({ tailnetId, userId: keeperId });
    expect(node.service.pairs()).toEqual([
      expect.objectContaining({
        id: pairingId,
        peerStableId: houseNode.stableId,
        peerUserId: keeperId,
        role: "console",
        confirmedBy: "on-device",
      }),
    ]);
    expect(
      (await pairSecretOf(node.keys, pairingId))?.equals(consoleSide.secret ?? Buffer.alloc(0)),
    ).toBe(true);
    const rows = await node.rows();
    expect(rows.map(({ capability, decision }) => `${capability} ${decision}`)).toEqual([
      "pair.hello allow",
      "pair.reveal allow",
      "pair.confirm-on-device allow",
      "pair.confirm allow",
    ]);
    expect(verifyAuditChain(rows)).toMatchObject({ intact: true, rows: 4 });
  });

  it("refuses a second human at hello and audits the attempt", async () => {
    const node = await target();
    const { reply } = await greet(node.service, houseNode, "console", strangerId);
    expect(reply).toEqual({ refused: "forbidden", error: "not-the-owner" });
    expect(node.events).toContainEqual({
      type: "mesh.pairing.refused",
      peerStableId: houseNode.stableId,
      reason: "not-the-owner",
    });
    expect(await node.rows()).toEqual([
      expect.objectContaining({
        actorUserID: strangerId,
        capability: "pair.hello",
        decision: "deny",
        reason: "not-the-owner",
      }),
    ]);
  });

  it("pairs a headless host with its one-time claim code", async () => {
    const node = await target({ headless: true });
    const claim = await issueClaimCode(node.keys);
    const { consoleSide, caller, pairingId, confirmation } = await revealed(node.service);
    expect(confirmation).toBe("claim-code");
    const reply = await node.service.confirm(
      caller,
      pairingId,
      confirmationOf(consoleSide, claim.code.toLowerCase()),
    );
    expect(reply).toMatchObject({ state: "paired" });
    const second = await revealed(node.service);
    expect(second.confirmation).toBe("endorsement");
  });

  it("aborts a headless claim with the wrong code", async () => {
    const node = await target({ headless: true });
    await issueClaimCode(node.keys);
    const { consoleSide, caller, pairingId } = await revealed(node.service);
    const reply = await node.service.confirm(
      caller,
      pairingId,
      confirmationOf(consoleSide, "AAAA-AAAA-AAAA"),
    );
    expect(reply).toEqual({ state: "aborted", reason: "bad-claim-code" });
    expect(node.service.claimState()).toBe("unclaimed");
  });

  it("lets only a paired owner console endorse a pairing on a claimed node", async () => {
    const node = await target();
    const first = await revealed(node.service);
    await node.service.confirmOnDevice(first.pairingId, first.consoleSide.sas ?? "");
    await node.service.confirm(first.caller, first.pairingId, confirmationOf(first.consoleSide));
    const [consolePair] = node.service.pairs();
    if (consolePair === undefined) throw new Error("no pair");
    const second = await revealed(node.service, taggedNode, "node");
    expect(second.confirmation).toBe("endorsement");
    const asNode: Authenticated = {
      pair: { ...consolePair, role: "node" },
      caller: callerOf(houseNode),
      body: "",
    };
    expect(
      await node.service.endorse(asNode, second.pairingId, { sas: second.consoleSide.sas }),
    ).toMatchObject({
      refused: "forbidden",
    });
    expect(node.service.pending().map(({ pairingId }) => pairingId)).toEqual([second.pairingId]);
    const owner: Authenticated = { pair: consolePair, caller: callerOf(houseNode), body: "" };
    expect(
      await node.service.endorse(owner, second.pairingId, { sas: second.consoleSide.sas }),
    ).toEqual({
      state: "confirming",
    });
    expect(
      await node.service.confirm(
        second.caller,
        second.pairingId,
        confirmationOf(second.consoleSide),
      ),
    ).toMatchObject({
      state: "paired",
    });
    expect(node.service.pairs().map(({ role, peerStableId }) => `${role} ${peerStableId}`)).toEqual(
      [`console ${houseNode.stableId}`, `node ${taggedNode.stableId}`],
    );
  });

  it("hides an attempt from every caller but the one that opened it", async () => {
    const node = await target();
    const { pairingId } = await revealed(node.service);
    expect(await node.service.status(callerOf(hostNode), pairingId)).toMatchObject({
      refused: "missing",
    });
    expect(await node.service.cancel(callerOf(hostNode), pairingId)).toMatchObject({
      refused: "missing",
    });
    expect(await node.service.cancel(callerOf(houseNode), pairingId)).toEqual({
      state: "aborted",
      reason: "cancelled",
    });
  });

  it("forgets attempts once they expire", async () => {
    let clock = 1_000;
    const node = await target({ now: () => clock });
    const { pairingId, caller } = await revealed(node.service);
    clock += 5 * 60_000;
    expect(await node.service.status(caller, pairingId)).toMatchObject({ refused: "missing" });
    expect(node.service.pending()).toEqual([]);
  });
});

describe("pairingService.authenticate", () => {
  async function paired() {
    let clock = Date.parse("2026-11-05T12:00:00Z");
    const node = await target({ now: () => clock });
    const { consoleSide, caller, pairingId } = await revealed(node.service);
    await node.service.confirmOnDevice(pairingId, consoleSide.sas ?? "");
    await node.service.confirm(caller, pairingId, confirmationOf(consoleSide));
    const secret = consoleSide.secret ?? Buffer.alloc(0);
    const headersFor = (body: string, path: string, secretKey: Buffer) =>
      signedHeaders(pairingId, secretKey, { method: "POST", target: path, body }, clock);
    const sent = (body: string, path: string, headers: Record<string, string>) =>
      new Request(`http://100.88.77.66:47800${path}`, { method: "POST", headers, body });
    const signed = (body: string, path = "/mesh/tools/call", secretKey = secret) =>
      sent(body, path, headersFor(body, path, secretKey));
    const later = (ms: number) => {
      clock += ms;
    };
    return { node, caller, pairingId, signed, sent, headersFor, secret, later };
  }

  it("admits a request whose WhoIs matches the pair and whose MAC holds, once", async () => {
    const { node, caller, pairingId, sent, headersFor, secret } = await paired();
    const headers = headersFor('{"x":1}', "/mesh/tools/call", secret);
    const replay = sent('{"x":1}', "/mesh/tools/call", headers);
    const admitted = await node.service.authenticate(
      sent('{"x":1}', "/mesh/tools/call", headers),
      caller,
    );
    expect(admitted).toMatchObject({ pair: { id: pairingId }, body: '{"x":1}' });
    expect(await node.service.authenticate(replay, caller)).toEqual({
      refused: "unauthenticated",
      error: "replayed",
    });
  });

  const unchanged = (request: Request) => request;
  const retagged: MeshCaller = {
    ...callerOf(houseNode),
    node: { ...callerOf(houseNode).node, tags: ["tag:x"] },
  };
  const deniedCases: [AuthFailure, (request: Request) => Request, MeshCaller][] = [
    [
      "no-proof",
      (request) => new Request(request.url, { method: "POST", body: "{}" }),
      callerOf(houseNode),
    ],
    ["node-mismatch", unchanged, callerOf(hostNode)],
    ["human-mismatch", unchanged, callerOf(houseNode, strangerId)],
    ["tags-changed", unchanged, retagged],
  ];

  it.each(deniedCases)("denies %s", async (reason, change, caller) => {
    const { node, signed } = await paired();
    expect(await node.service.authenticate(change(signed("{}")), caller)).toEqual({
      refused: "unauthenticated",
      error: reason,
    });
    expect((await node.rows()).at(-1)).toMatchObject({
      capability: "request",
      decision: "deny",
      reason,
    });
  });

  it("denies a stale request, a forged MAC and an unknown pair", async () => {
    const { node, caller, signed, later } = await paired();
    const old = signed("{}");
    later(61_000);
    expect(await node.service.authenticate(old, caller)).toMatchObject({ error: "stale" });
    expect(
      await node.service.authenticate(signed("{}", "/mesh/tools/call", Buffer.alloc(32)), caller),
    ).toMatchObject({
      error: "bad-mac",
    });
    await node.service.unpair(node.service.pairs()[0]?.id ?? "", "keeper");
    expect(await node.service.authenticate(signed("{}"), caller)).toMatchObject({
      error: "unknown-pair",
    });
    expect(node.events.at(-1)).toMatchObject({ type: "mesh.pair.removed", by: "keeper" });
  });
});
