import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MeshCensus, MockProvider } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { creatureHost } from "../../../engine/src/creatures/host.ts";
import { type CreatureMail, creatureMail } from "../../../engine/src/creatures/messages/index.ts";
import { CreatureRegistry } from "../../../engine/src/creatures/registry.ts";
import { FakeCreatureSessions } from "../../../engine/src/creatures/testing.ts";
import {
  fileAuditLog,
  meshAuditFile,
  pullAudit,
  verifyAuditFile,
} from "../../../engine/src/mesh/audit/index.ts";
import {
  callRemoteTool,
  type GrantEvent,
  grantService,
  ledgerGate,
  memoryGrantStore,
} from "../../../engine/src/mesh/grants/index.ts";
import {
  isPairingFailure,
  loadDeviceKey,
  memoryKeyStore,
  memoryPairStore,
  meshClient,
  type PairingEvent,
  type PairRecord,
  pairingService,
} from "../../../engine/src/mesh/pairing/index.ts";
import {
  hostNode,
  houseNode,
  selfOf,
  strangerId,
  type TestNode,
  whoisOf,
} from "../../../engine/src/mesh/pairing/testing/identities.ts";
import {
  fakeTailnet,
  withStatus,
} from "../../../engine/src/mesh/transport/testing/fake-tailnet.ts";
import { bashTool } from "../../../engine/src/tools/bash.ts";
import { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import { admit, probeHello, type TailnetListener } from "../mesh/engine-mesh.ts";
import { meshRouter } from "../mesh/router.ts";
import { registerMeshListener } from "../mesh-listener.ts";
import { openApiDocument } from "../openapi.ts";
import { memorySessionHost } from "../testing.ts";
import {
  type MeshConsole,
  meshFamily,
  meshRoutes,
  meshTrustRoutes,
  pairedManifestReader,
} from "./mesh.ts";

const listeners: TailnetListener[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "keywork-mesh-node-"));
  directories.push(directory);
  return directory;
}

interface MeshNode {
  self: TestNode;
  mesh: MeshConsole;
  stateDir: string;
  port: number;
  endpoint: string;
  pairingEvents: PairingEvent[];
  grantEvents: GrantEvent[];
  tailnet: ReturnType<typeof fakeTailnet>;
  loopback: ReturnType<ReturnType<typeof meshFamily>["handlers"]>;
}

async function meshNode(
  self: TestNode,
  peer: TestNode,
  mailOf?: (mesh: MeshConsole) => CreatureMail,
): Promise<MeshNode> {
  const stateDir = scratch();
  const keys = memoryKeyStore();
  const deviceKey = await loadDeviceKey(keys);
  const store = memoryPairStore();
  const audit = fileAuditLog(meshAuditFile(stateDir));
  const identity = async () => selfOf(self);
  const pairingEvents: PairingEvent[] = [];
  const grantEvents: GrantEvent[] = [];
  const pairing = pairingService({
    deviceKey,
    keys,
    store,
    audit,
    self: identity,
    onEvent: (event) => pairingEvents.push(event),
  });
  const client = meshClient({ deviceKey, keys, store, self: identity, pollMs: 10 });
  const grants = grantService({
    deviceKey,
    pairing,
    client,
    store: memoryGrantStore(),
    audit,
    self: identity,
    gate: ledgerGate({
      root: stateDir,
      tools: () => [bashTool(stateDir)],
      ask: async () => false,
    }),
    onEvent: (event) => grantEvents.push(event),
  });
  const trust: MeshConsole = { pairing, grants, audit, client };
  const mesh: MeshConsole = { ...trust, messages: mailOf?.(trust) };
  const tailnet = fakeTailnet();
  tailnet.current.status = withStatus(tailnet.current.status, { tailscaleIPs: [self.address] });
  tailnet.current.identities.set("127.0.0.1", whoisOf(peer));
  const listener = await registerMeshListener({
    version: "0.4.0",
    tailnet,
    pollMs: 0,
    localAddresses: () => [self.address],
    listen: (server) =>
      new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
      ),
    inventory: { gpus: async () => [] },
    pairing: () => pairing.claimState(),
    mayReadManifest: pairedManifestReader(pairing),
    routes: meshTrustRoutes(mesh),
  });
  listeners.push(listener);
  const port = listener.bound()[0]?.port ?? 0;
  return {
    self,
    mesh,
    stateDir,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    pairingEvents,
    grantEvents,
    tailnet,
    loopback: loopbackHandlers(mesh),
  };
}

function loopbackHandlers(mesh: MeshConsole) {
  const log = new EventLog();
  const host: SessionHost = memorySessionHost({ log, provider: new MockProvider([]) });
  return meshFamily(() => mesh).handlers({
    host,
    log,
    streams: { add: () => () => undefined },
    describe: () => openApiDocument("http://127.0.0.1:4770", "test"),
  });
}

function local(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:4770${path}`, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
}

async function targetOf(console: MeshNode, node: MeshNode) {
  const whois = await console.tailnet.whois("127.0.0.1");
  if (whois === null) throw new Error("the console cannot identify the node");
  return {
    endpoint: node.endpoint,
    stableId: whois.node.stableId,
    userId: whois.user.id,
    tags: whois.node.tags,
  };
}

async function paired(house: MeshNode, host: MeshNode): Promise<PairRecord> {
  const begun = await house.loopback.beginMeshPairing(
    local("POST", "/mesh/pairs", {
      ...(await targetOf(house, host)),
      role: "console",
      caps: ["exec"],
    }),
    {},
  );
  expect(begun.status).toBe(201);
  const { attemptId, sas, confirmation } = (await begun.json()) as {
    attemptId: string;
    sas: string;
    confirmation: string;
  };
  expect(confirmation).toBe("on-device");
  const shown = host.mesh.pairing.pending().find(({ pairingId }) => pairingId === attemptId);
  expect(shown?.sas).toBe(sas);
  const here = await host.loopback.confirmMeshPairingHere(
    local("POST", `/mesh/pairings/${attemptId}/confirm`, { sas: shown?.sas }),
    {
      id: attemptId,
    },
  );
  expect(await here.json()).toEqual({ state: "confirming" });
  const completed = await house.loopback.completeMeshPairing(
    local("POST", `/mesh/pairs/${attemptId}/complete`, { matches: shown?.sas === sas }),
    { id: attemptId },
  );
  expect(completed.status).toBe(200);
  const { paired } = (await completed.json()) as { paired: PairRecord };
  return paired;
}

const echoGrant = (expiresAt: string) => ({
  subject: { creature: "pip", node: houseNode.stableId },
  target: hostNode.stableId,
  caps: [{ kind: "exec", commands: ["echo"] }],
  expiresAt,
});

describe("mesh pairing, grants and audit across two nodes", () => {
  it("pairs with SAS, runs a granted exec through the target's gate, audits it, and refuses it after revoke", async () => {
    const house = await meshNode(houseNode, hostNode);
    const host = await meshNode(hostNode, houseNode);
    expect(await probeHello("127.0.0.1", host.port)).toMatchObject({ pairing: "unclaimed" });

    const pair = await paired(house, host);
    expect(pair).toMatchObject({
      peerStableId: hostNode.stableId,
      role: "target",
      endpoint: host.endpoint,
    });
    expect(host.mesh.pairing.pairs()).toEqual([
      expect.objectContaining({ id: pair.id, peerStableId: houseNode.stableId, role: "console" }),
    ]);
    expect(await probeHello("127.0.0.1", host.port)).toMatchObject({ pairing: "claimed" });
    expect((await fetch(`${host.endpoint}/mesh/manifest`)).status).toBe(200);

    const issued = await house.loopback.issueMeshGrant(
      local("POST", "/mesh/grants", echoGrant(new Date(Date.now() + 60 * 60_000).toISOString())),
      {},
    );
    expect(issued.status).toBe(201);
    const grant = (await issued.json()) as { id: string };
    expect(host.mesh.grants.list().installed.map(({ id }) => id)).toEqual([grant.id]);

    const call = {
      creature: "pip",
      grantId: grant.id,
      call: { callId: "call-1", name: "bash", arguments: { command: "echo hello-from-pip" } },
    };
    const ran = await callRemoteTool(house.mesh.client, pair, call);
    expect(ran).toMatchObject({
      verdict: "allowed",
      isError: false,
      reason: "allowed by the grant's rules",
    });
    expect(ran.output).toContain("hello-from-pip");
    expect(host.grantEvents).toContainEqual(
      expect.objectContaining({
        type: "mesh.tool.call",
        origin: { kind: "mesh", creature: "pip", node: houseNode.stableId },
        grantId: grant.id,
      }),
    );
    const afterRun = await host.mesh.audit.rows();
    expect(afterRun.at(-1)).toMatchObject({
      actorStableID: houseNode.stableId,
      targetStableID: hostNode.stableId,
      capability: "exec",
      decision: "allow",
      prevHash: afterRun.at(-2)?.hash,
    });

    const revoked = await house.loopback.revokeMeshGrant(
      local("DELETE", `/mesh/grants/${grant.id}`),
      { id: grant.id },
    );
    expect(revoked.status).toBe(200);
    expect(host.mesh.grants.list().installed).toEqual([]);
    const refused = await callRemoteTool(house.mesh.client, pair, {
      ...call,
      call: { ...call.call, callId: "call-2" },
    });
    expect(refused).toMatchObject({
      verdict: "denied",
      isError: true,
      reason: expect.stringMatching(/^no-grant/),
    });
    expect((await host.mesh.audit.rows()).at(-1)).toMatchObject({
      capability: "tool",
      decision: "deny",
    });

    const pulled = await pullAudit(house.mesh.client, pair);
    expect(pulled.verdict).toMatchObject({ intact: true });
    expect(pulled.rows.map(({ capability, decision }) => `${capability} ${decision}`)).toEqual([
      "pair.hello allow",
      "pair.reveal allow",
      "pair.confirm-on-device allow",
      "pair.confirm allow",
      "grant.install allow",
      "exec allow",
      "revocation allow",
      "tool deny",
    ]);
    expect(await verifyAuditFile(meshAuditFile(host.stateDir))).toMatchObject({
      intact: true,
      rows: 8,
    });
  });

  it("asks the target's keeper for an exec the grant does not cover and records the refusal", async () => {
    const house = await meshNode(houseNode, hostNode);
    const host = await meshNode(hostNode, houseNode);
    const pair = await paired(house, host);
    const grant = await house.mesh.grants.issue(
      echoGrant(new Date(Date.now() + 60_000).toISOString()),
    );
    if ("refused" in grant) throw new Error(grant.error);
    const listed = await callRemoteTool(house.mesh.client, pair, {
      creature: "pip",
      grantId: grant.id,
      call: { callId: "c", name: "bash", arguments: { command: "ls" } },
    });
    expect(listed).toMatchObject({ verdict: "denied", reason: "the keeper declined" });
    expect((await host.mesh.audit.rows()).at(-1)).toMatchObject({
      capability: "exec",
      decision: "deny",
    });
  });

  it("refuses a second human's hello and requests without a pair key", async () => {
    const house = await meshNode(houseNode, hostNode);
    const host = await meshNode(hostNode, { ...houseNode, userId: strangerId });
    const begun = await house.mesh.client.begin(await targetOf(house, host), {
      role: "console",
      caps: [],
    });
    expect(isPairingFailure(begun) && begun.failed).toBe("not-the-owner");
    const unsigned = await fetch(`${host.endpoint}/mesh/tools/call`, {
      method: "POST",
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: "no-proof" });
    expect(
      (await host.mesh.audit.rows()).map(
        ({ capability, decision, reason }) => `${capability} ${decision} ${reason}`,
      ),
    ).toEqual(["pair.hello deny not-the-owner", "request deny no-proof"]);
  });

  it("waits for the target's keeper when the console confirms first", async () => {
    const house = await meshNode(houseNode, hostNode);
    const host = await meshNode(hostNode, houseNode);
    const begun = await house.mesh.client.begin(await targetOf(house, host), {
      role: "console",
      caps: [],
    });
    if (isPairingFailure(begun)) throw new Error(begun.detail);
    const completing = house.mesh.client.complete(begun.attemptId, { matches: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.mesh.pairing.pending()).toEqual([
      expect.objectContaining({ pairingId: begun.attemptId }),
    ]);
    await host.mesh.pairing.confirmOnDevice(begun.attemptId, begun.sas);
    expect(await completing).toMatchObject({ paired: { id: begun.attemptId, role: "target" } });
  });

  it("aborts a pairing when the keeper sees different codes", async () => {
    const house = await meshNode(houseNode, hostNode);
    const host = await meshNode(hostNode, houseNode);
    const begun = await house.mesh.client.begin(await targetOf(house, host), {
      role: "console",
      caps: [],
    });
    if (isPairingFailure(begun)) throw new Error(begun.detail);
    expect(await house.mesh.client.complete(begun.attemptId, { matches: false })).toMatchObject({
      failed: "rejected",
    });
    expect(host.pairingEvents).toContainEqual({
      type: "mesh.pairing.aborted",
      pairingId: begun.attemptId,
      reason: "cancelled",
    });
    expect(host.mesh.pairing.claimState()).toBe("unclaimed");
  });
});

describe("the mesh console routes", () => {
  it("declare the pairing, grant and audit verbs", () => {
    expect(meshRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /mesh/pairs",
      "POST /mesh/pairs",
      "POST /mesh/pairs/{id}/complete",
      "POST /mesh/pairings/{id}/confirm",
      "DELETE /mesh/pairs/{id}",
      "GET /mesh/grants",
      "POST /mesh/grants",
      "DELETE /mesh/grants/{id}",
      "GET /mesh/audit",
      "POST /mesh/screen/audit",
      "POST /mesh/messages",
      "POST /mesh/messages/arrivals",
    ]);
    expect(meshRoutes.every((route) => route.authenticated)).toBe(true);
  });

  it("answer 503 when the host serves no mesh", async () => {
    const log = new EventLog();
    const host: SessionHost = memorySessionHost({ log, provider: new MockProvider([]) });
    const handlers = meshFamily(() => undefined).handlers({
      host,
      log,
      streams: { add: () => () => undefined },
      describe: () => openApiDocument("http://127.0.0.1:4770", "test"),
    });
    expect((await handlers.listMeshPairs(local("GET", "/mesh/pairs"), {})).status).toBe(503);
  });

  it("answer GET /mesh/peers with the lane traffic takes, not the idle one read before the census woke it", async () => {
    const node = await meshNode(houseNode, hostNode);
    const spark = {
      stableId: "nSpark",
      machine: "spark-ad4d",
      dnsName: "spark-ad4d.tailnet.ts.net.",
      os: "linux",
      addresses: ["100.85.160.9"],
      tags: [],
      user: null,
      online: true,
      candidate: true,
      node: null,
      manifest: null,
    };
    const idle: MeshCensus = {
      self: null,
      peers: [{ ...spark, active: false, path: { kind: "derp", region: "ord" } }],
    };
    const woken: MeshCensus = {
      self: null,
      peers: [{ ...spark, active: true, path: { kind: "direct", endpoint: "192.168.4.58:41641" } }],
    };
    const takes = [idle, woken];
    let taken = 0;
    const handlers = loopbackHandlers({
      ...node.mesh,
      census: async () => {
        taken += 1;
        return takes.shift() ?? woken;
      },
    });
    const answered = await handlers.listMeshPeers(local("GET", "/mesh/peers"), {});
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      peers: [{ stableId: "nSpark", path: { kind: "direct", endpoint: "192.168.4.58:41641" } }],
    });
    expect(taken).toBe(2);
  });

  it("list pairs and grants, map refusals, and report the audit chain", async () => {
    const node = await meshNode(hostNode, houseNode);
    const listed = await node.loopback.listMeshPairs(local("GET", "/mesh/pairs"), {});
    expect(await listed.json()).toEqual({
      claim: "unclaimed",
      owner: null,
      pairs: [],
      pending: [],
    });
    expect(
      await (await node.loopback.listMeshGrants(local("GET", "/mesh/grants"), {})).json(),
    ).toEqual({
      installed: [],
      issued: [],
    });
    const unpaired = await node.loopback.issueMeshGrant(
      local("POST", "/mesh/grants", {
        ...echoGrant(new Date(Date.now() + 60_000).toISOString()),
        target: "nElsewhere",
      }),
      {},
    );
    expect(unpaired.status).toBe(404);
    expect(
      (await node.loopback.issueMeshGrant(local("POST", "/mesh/grants", { caps: [] }), {})).status,
    ).toBe(400);
    expect(
      (await node.loopback.revokeMeshGrant(local("DELETE", "/mesh/grants/nope"), { id: "nope" }))
        .status,
    ).toBe(404);
    expect(
      (await node.loopback.removeMeshPair(local("DELETE", "/mesh/pairs/nope"), { id: "nope" }))
        .status,
    ).toBe(404);
    expect(
      (
        await node.loopback.confirmMeshPairingHere(
          local("POST", "/mesh/pairings/nope/confirm", { sas: "123456" }),
          { id: "nope" },
        )
      ).status,
    ).toBe(404);
    expect(
      (await node.loopback.beginMeshPairing(local("POST", "/mesh/pairs", { role: "boss" }), {}))
        .status,
    ).toBe(400);
    const audit = await node.loopback.meshAudit(local("GET", "/mesh/audit"), {});
    expect(await audit.json()).toEqual({
      rows: [],
      chain: { intact: true, head: "0".repeat(64), rows: 0 },
    });
  });
});

describe("the screen audit route", () => {
  it("chains a control session and a refused agent control into the audit log, each in words", async () => {
    const node = await meshNode(hostNode, houseNode);
    const peer = {
      stableId: "nSparkStable1",
      name: "spark-ad4d",
      userId: "u-keeper",
      loginName: "jordan@example.com",
      tags: [],
    };
    const session = await node.loopback.recordScreenAudit(
      local("POST", "/mesh/screen/audit", {
        kind: "session",
        sessionId: "session-1",
        grantId: "grant-view",
        controlGrantId: "grant-control",
        peer,
        controller: "human",
        scopes: ["view", "control"],
        displays: ["2528732444"],
        path: "direct",
        startedAt: "2026-11-06T09:00:00.000Z",
        endedAt: "2026-11-06T09:12:00.000Z",
        reason: "kill-switch",
        inputs: { pointer: 120, keys: 14 },
      }),
      {},
    );
    expect(session.status).toBe(201);
    const refused = await node.loopback.recordScreenAudit(
      local("POST", "/mesh/screen/audit", {
        kind: "control",
        sessionId: "session-2",
        grantId: "grant-view-2",
        peer: { stableId: "nWorkshop", name: "otter-shop", userId: null, tags: ["tag:workshop"] },
        controller: "agent",
        decision: "deny",
        reason: "a creature may control only its own workshop's display, never a keeper's desktop",
      }),
      {},
    );
    expect(refused.status).toBe(201);
    const audit = (await (
      await node.loopback.meshAudit(local("GET", "/mesh/audit"), {})
    ).json()) as { rows: Array<{ capability: string; decision: string; reason: string }> };
    expect(audit.rows.map(({ capability, decision }) => `${capability} ${decision}`)).toEqual([
      "screen:control allow",
      "screen:control deny",
    ]);
    expect(audit.rows[0]?.reason).toContain("ended: kill-switch · 120 pointer, 14 keys");
    expect(audit.rows[1]?.reason).toContain("never a keeper's desktop");
    const malformed = await node.loopback.recordScreenAudit(
      local("POST", "/mesh/screen/audit", { kind: "session", scopes: [] }),
      {},
    );
    expect(malformed.status).toBe(400);
  });
});

describe("the screen signaling relay among the trust routes", () => {
  it("mounts GET and POST /mesh/screen/signal when the node shares a house, and refuses a caller without a ticket in words", async () => {
    const node = await meshNode(houseNode, hostNode);
    const trust = {
      ...node.mesh,
      screen: {
        house: "house-ticket-for-the-route-test-0123456789",
        self: () => "nSelf",
        machine: () => "moak-main",
        pairSecret: async () => undefined,
      },
    };
    const router = meshRouter(meshTrustRoutes(trust));
    const caller = admitted(whoisOf(hostNode));
    for (const method of ["GET", "POST"]) {
      const answer = await router(
        new Request(`${node.endpoint}/mesh/screen/signal?session=s1`, {
          method,
          body: method === "POST" ? "{}" : null,
        }),
        caller,
      );
      expect(answer.status).toBe(401);
      expect(((await answer.json()) as { error: string }).error).toMatch(
        /^a screen ticket is required/,
      );
    }
    const bare = meshRouter(meshTrustRoutes(node.mesh));
    const absent = await bare(new Request(`${node.endpoint}/mesh/screen/signal`), caller);
    expect(absent.status).toBe(404);
  });
});

function admitted(whois: Parameters<typeof admit>[1]) {
  const admission = admit("100.88.77.66", whois);
  if (!admission.admitted) throw new Error("the test caller is admitted");
  return admission.caller;
}

async function creaturesOn(...names: string[]) {
  const at = new Date("2026-11-06T09:00:00.000Z");
  const registry = new CreatureRegistry({
    root: scratch(),
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const host = creatureHost({ registry, sessions, now: () => at });
  for (const name of names) await host.create({ name });
  return { host, sessions };
}

function mailOver(self: TestNode, creatures: Awaited<ReturnType<typeof creaturesOn>>) {
  return (mesh: MeshConsole): CreatureMail =>
    creatureMail({
      mailboxes: creatures.host,
      pairs: () => mesh.pairing.pairs(),
      client: mesh.client,
      audit: mesh.audit,
      self: async () => selfOf(self),
      machine: () => self.name,
    });
}

describe("creature messages between paired machines", () => {
  it("refuses an unpaired machine in words, then lands a paired creature's words in the other conversation and audits both nodes", async () => {
    const atHouse = await creaturesOn("Ada");
    const atHost = await creaturesOn("Pip");
    const house = await meshNode(houseNode, hostNode, mailOver(houseNode, atHouse));
    const host = await meshNode(hostNode, houseNode, mailOver(hostNode, atHost));
    const message = (text: string) =>
      local("POST", "/mesh/messages", { from: "ada", to: "pip", node: hostNode.stableId, text });

    const unpaired = await house.loopback.sendCreatureMessage(message("hello"), {});
    expect(unpaired.status).toBe(403);
    expect(await unpaired.json()).toEqual({
      error: `this machine is not paired with ${hostNode.stableId}: pair the two machines before ada can message pip there`,
    });

    await paired(house, host);
    const sent = await house.loopback.sendCreatureMessage(message("the kettle is on"), {});
    expect(sent.status).toBe(201);
    const { delivered } = (await sent.json()) as { delivered: { id: string } };
    expect(delivered).toMatchObject({ from: "ada", to: "pip", node: houseNode.stableId, hop: 1 });
    const conversation = (await atHost.host.read("pip"))?.conversation;
    expect(atHost.sessions.injections).toEqual([
      {
        sessionId: conversation,
        text: "Message from ada on house: the kettle is on",
        origin: {
          kind: "creature",
          creature: "ada",
          thread: delivered.id,
          node: houseNode.stableId,
          machine: "house",
        },
      },
    ]);
    expect(atHost.sessions.turnsStarted(conversation ?? "")).toBe(0);
    expect((await host.mesh.audit.rows()).at(-1)).toMatchObject({
      actorStableID: houseNode.stableId,
      targetStableID: hostNode.stableId,
      capability: "message.receive",
      decision: "allow",
    });
    expect((await house.mesh.audit.rows()).at(-1)).toMatchObject({
      actorStableID: houseNode.stableId,
      targetStableID: hostNode.stableId,
      capability: "message.send",
      decision: "allow",
    });

    await atHost.host.update("pip", { inbound: "nobody" });
    const refused = await house.loopback.sendCreatureMessage(message("again"), {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: `${hostNode.stableId} refused: pip takes messages from nobody`,
    });
    expect(atHost.sessions.injections).toHaveLength(1);

    const unsigned = await fetch(`${host.endpoint}/mesh/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "msg-00000009", from: "ada", to: "pip", text: "hi", hop: 1 }),
    });
    expect(unsigned.status).toBe(401);
    expect(atHost.sessions.injections).toHaveLength(1);
  });

  it("takes an arrival the node hands a workspace, with the caller WhoIs named", async () => {
    const atHost = await creaturesOn("Pip");
    const host = await meshNode(hostNode, houseNode, mailOver(hostNode, atHost));
    const arrival = {
      message: { id: "msg-00000001", from: "ada", to: "pip", text: "hi from afar", hop: 1 },
      caller: { stableId: houseNode.stableId, name: "house", userId: houseNode.userId, tags: [] },
    };
    const taken = await host.loopback.takeCreatureMessage(
      local("POST", "/mesh/messages/arrivals", arrival),
      {},
    );
    expect(taken.status).toBe(201);
    expect(atHost.sessions.injections.at(-1)?.text).toBe("Message from ada on house: hi from afar");
    const elsewhere = await host.loopback.takeCreatureMessage(
      local("POST", "/mesh/messages/arrivals", {
        ...arrival,
        message: { ...arrival.message, id: "msg-00000002", to: "wren" },
      }),
      {},
    );
    expect(elsewhere.status).toBe(404);
    const forged = await host.loopback.takeCreatureMessage(
      local("POST", "/mesh/messages/arrivals", { ...arrival, grants: ["exec"] }),
      {},
    );
    expect(forged.status).toBe(400);
  });

  it("answers 503 when the node serves no creature messages, and leaves the tailnet route unmounted", async () => {
    const house = await meshNode(houseNode, hostNode);
    const response = await house.loopback.sendCreatureMessage(
      local("POST", "/mesh/messages", { from: "ada", to: "pip", text: "hi" }),
      {},
    );
    expect(response.status).toBe(503);
    const raw = await fetch(`${house.endpoint}/mesh/messages`, { method: "POST", body: "{}" });
    expect(await raw.json()).toEqual({ error: "mesh.not-found" });
  });
});
