import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type NodeRole } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { fileAuditLog, meshAuditFile } from "../../../engine/src/mesh/audit/index.ts";
import {
  type CensusOptions,
  readPeerManifest,
  takeCensus,
} from "../../../engine/src/mesh/discovery/index.ts";
import {
  grantService,
  ledgerGate,
  memoryGrantStore,
} from "../../../engine/src/mesh/grants/index.ts";
import {
  loadDeviceKey,
  memoryKeyStore,
  memoryPairStore,
  meshClient,
  pairingService,
} from "../../../engine/src/mesh/pairing/index.ts";
import {
  hostNode,
  houseNode,
  selfOf,
  type TestNode,
  whoisOf,
} from "../../../engine/src/mesh/pairing/testing/identities.ts";
import { parseStatus } from "../../../engine/src/mesh/transport/status.ts";
import {
  fakeTailnet,
  withStatus,
} from "../../../engine/src/mesh/transport/testing/fake-tailnet.ts";
import { recordedHost, recordedText } from "../../../engine/src/mesh/transport/testing/recorded.ts";
import { bashTool } from "../../../engine/src/tools/bash.ts";
import { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import type { TailnetListener } from "../mesh/engine-mesh.ts";
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
import { meshConsoleRoutes } from "./mesh-console.ts";

const listeners: TailnetListener[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ConsoleNode {
  mesh: MeshConsole;
  endpoint: string;
}

async function consoleNode(
  self: TestNode,
  peer: TestNode,
  roles: readonly NodeRole[],
): Promise<ConsoleNode> {
  const stateDir = mkdtempSync(join(tmpdir(), "keywork-mesh-console-"));
  directories.push(stateDir);
  const keys = memoryKeyStore();
  const deviceKey = await loadDeviceKey(keys);
  const store = memoryPairStore();
  const audit = fileAuditLog(meshAuditFile(stateDir));
  const identity = async () => selfOf(self);
  const pairing = pairingService({ deviceKey, keys, store, audit, self: identity });
  const client = meshClient({ deviceKey, keys, store, self: identity, pollMs: 10 });
  const grants = grantService({
    deviceKey,
    pairing,
    client,
    store: memoryGrantStore(),
    audit,
    self: identity,
    gate: ledgerGate({ root: stateDir, tools: () => [bashTool(stateDir)], ask: async () => false }),
  });
  const mesh: MeshConsole = { pairing, grants, audit, client };
  const tailnet = fakeTailnet();
  tailnet.current.status = withStatus(tailnet.current.status, { tailscaleIPs: [self.address] });
  tailnet.current.identities.set("127.0.0.1", whoisOf(peer));
  const listener = await registerMeshListener({
    version: "0.4.0",
    tailnet,
    pollMs: 0,
    roles,
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
  return { mesh, endpoint: `http://127.0.0.1:${listener.bound()[0]?.port ?? 0}` };
}

function loopback(mesh: MeshConsole | undefined, now?: () => number) {
  const log = new EventLog();
  const host: SessionHost = memorySessionHost({ log, provider: new MockProvider([]) });
  return meshFamily(() => mesh, now === undefined ? {} : { now }).handlers({
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

async function answer(response: Promise<Response>): Promise<{ status: number; body: unknown }> {
  const settled = await response;
  return { status: settled.status, body: await settled.json() };
}

const meshPort = 47800;
const hostTailnetEndpoint = `http://${recordedHost.ipv4}:${meshPort}`;

function tailnetTo(node: ConsoleNode): NonNullable<CensusOptions["fetch"]> {
  return async (url, init) => {
    const routed = url.replace(hostTailnetEndpoint, node.endpoint);
    if (!routed.startsWith("http://127.0.0.1:")) throw new Error(`no route to ${url}`);
    return fetch(routed, init);
  };
}

function houseCensus(house: ConsoleNode, host: ConsoleNode): () => ReturnType<typeof takeCensus> {
  const status = parseStatus(recordedText("status-running"));
  return () =>
    takeCensus({
      tailnet: { status: async () => status },
      port: meshPort,
      fetch: tailnetTo(host),
      pairs: () => house.mesh.pairing.pairs(),
    });
}

async function begun(house: ConsoleNode, host: ConsoleNode, routes = loopback(house.mesh)) {
  const started = await answer(
    routes.beginMeshPairing(
      local("POST", "/mesh/pairs", {
        endpoint: host.endpoint,
        stableId: hostNode.stableId,
        userId: hostNode.userId,
        tags: [],
        role: "console",
        caps: ["exec"],
      }),
      {},
    ),
  );
  expect(started.status).toBe(201);
  return started.body as { attemptId: string; sas: string; expiresAt: string };
}

describe("the console mesh view routes", () => {
  it("join the mesh family after the pairing, grant and audit verbs", () => {
    expect(
      meshConsoleRoutes.map((route) => `${route.method} ${route.path} ${route.operationId}`),
    ).toEqual(["GET /mesh/peers listMeshPeers", "GET /mesh/pairings listMeshPairings"]);
    expect(meshConsoleRoutes.every((route) => route.authenticated)).toBe(true);
    expect(meshFamily(() => undefined).routes).toEqual([...meshRoutes, ...meshConsoleRoutes]);
    const paths = openApiDocument("http://127.0.0.1:4770", "test").paths;
    expect(paths["/mesh/peers"]?.get?.operationId).toBe("listMeshPeers");
    expect(paths["/mesh/pairings"]?.get?.operationId).toBe("listMeshPairings");
  });

  it("answer 503 without a mesh or a census and 502 when tailscale fails", async () => {
    expect((await loopback(undefined).listMeshPeers(local("GET", "/mesh/peers"), {})).status).toBe(
      503,
    );
    expect(
      (await loopback(undefined).listMeshPairings(local("GET", "/mesh/pairings"), {})).status,
    ).toBe(503);
    const house = await consoleNode(houseNode, hostNode, ["console"]);
    expect(
      await answer(loopback(house.mesh).listMeshPeers(local("GET", "/mesh/peers"), {})),
    ).toEqual({
      status: 503,
      body: { error: "the tailnet census is not served by this host" },
    });
    const failing: MeshConsole = {
      ...house.mesh,
      census: async () => {
        throw new Error("tailscaled is not answering");
      },
    };
    expect(await answer(loopback(failing).listMeshPeers(local("GET", "/mesh/peers"), {}))).toEqual({
      status: 502,
      body: { error: "tailscale did not answer: tailscaled is not answering" },
    });
  });

  it("show an unpaired node without its manifest, then its roles once paired", async () => {
    const house = await consoleNode(houseNode, hostNode, ["console"]);
    const host = await consoleNode(hostNode, houseNode, ["host", "reachable"]);
    const census = houseCensus(house, host);
    const routes = loopback({ ...house.mesh, census });

    const before = await answer(routes.listMeshPeers(local("GET", "/mesh/peers"), {}));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      self: { stableId: houseNode.stableId, manifest: null },
      peers: [
        {
          stableId: hostNode.stableId,
          path: { kind: "derp", region: "ord" },
          node: { product: "keywork", version: "0.4.0", pairing: "unclaimed" },
          manifest: null,
          endpoint: hostTailnetEndpoint,
        },
      ],
    });
    expect(await readPeerManifest(host.endpoint)).toBeNull();

    const { attemptId, sas } = await begun(house, host, routes);
    await host.mesh.pairing.confirmOnDevice(attemptId, sas);
    const completed = await routes.completeMeshPairing(
      local("POST", `/mesh/pairs/${attemptId}/complete`, { matches: true }),
      { id: attemptId },
    );
    expect(completed.status).toBe(200);

    const after = await answer(routes.listMeshPeers(local("GET", "/mesh/peers"), {}));
    expect(after.body).toMatchObject({
      peers: [
        {
          stableId: hostNode.stableId,
          node: { pairing: "claimed" },
          manifest: { roles: ["host", "reachable"] },
          endpoint: host.endpoint,
        },
      ],
    });
  });

  it("list the attempts this console began until each completes, fails or expires", async () => {
    const house = await consoleNode(houseNode, hostNode, ["console"]);
    const host = await consoleNode(hostNode, houseNode, ["host"]);
    let clock = Date.now();
    const routes = loopback(house.mesh, () => clock);
    const pairings = async () =>
      (
        (await answer(routes.listMeshPairings(local("GET", "/mesh/pairings"), {}))).body as {
          pairings: { attemptId: string; phase: string; sas: string }[];
        }
      ).pairings;

    const first = await begun(house, host, routes);
    expect(await pairings()).toEqual([
      {
        attemptId: first.attemptId,
        peerStableId: hostNode.stableId,
        peerUserId: hostNode.userId,
        endpoint: host.endpoint,
        role: "console",
        caps: ["exec"],
        sas: first.sas,
        confirmation: "on-device",
        phase: "comparing",
        startedAt: new Date(clock).toISOString(),
        expiresAt: first.expiresAt,
      },
    ]);
    expect(host.mesh.pairing.pending().map(({ sas }) => sas)).toEqual([first.sas]);

    const completing = routes.completeMeshPairing(
      local("POST", `/mesh/pairs/${first.attemptId}/complete`, { matches: true }),
      { id: first.attemptId },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await pairings()).map(({ phase }) => phase)).toEqual(["confirming"]);
    await host.mesh.pairing.confirmOnDevice(first.attemptId, first.sas);
    expect((await completing).status).toBe(200);
    expect(await pairings()).toEqual([]);

    const refused = await routes.beginMeshPairing(
      local("POST", "/mesh/pairs", {
        endpoint: host.endpoint,
        stableId: "nSomeoneElseCNTRL",
        role: "console",
      }),
      {},
    );
    expect(refused.status).toBe(502);
    expect(await pairings()).toEqual([]);

    const second = await begun(house, host, routes);
    expect((await pairings()).map(({ attemptId }) => attemptId)).toEqual([second.attemptId]);
    clock = Date.parse(second.expiresAt);
    expect(await pairings()).toEqual([]);
  });

  it("page the audit newest first on ?order=newest", async () => {
    const house = await consoleNode(houseNode, hostNode, ["console"]);
    const host = await consoleNode(hostNode, houseNode, ["host"]);
    const { attemptId, sas } = await begun(house, host);
    await host.mesh.pairing.confirmOnDevice(attemptId, sas);
    await loopback(house.mesh).completeMeshPairing(
      local("POST", `/mesh/pairs/${attemptId}/complete`, { matches: true }),
      { id: attemptId },
    );
    const routes = loopback(host.mesh);
    const page = async (query: string) => {
      const read = await answer(routes.meshAudit(local("GET", `/mesh/audit${query}`), {}));
      const body = read.body as { rows: { capability: string; hash: string }[]; chain: unknown };
      return { status: read.status, rows: body.rows, chain: body.chain };
    };
    const oldest = await page("");
    expect(oldest.rows.map(({ capability }) => capability)).toEqual([
      "pair.hello",
      "pair.reveal",
      "pair.confirm-on-device",
      "pair.confirm",
    ]);
    const newest = await page("?order=newest&limit=2");
    expect(newest.rows.map(({ capability }) => capability)).toEqual([
      "pair.confirm",
      "pair.confirm-on-device",
    ]);
    expect(newest.chain).toEqual(oldest.chain);
    const older = await page(`?order=newest&limit=2&after=${newest.rows[1]?.hash}`);
    expect(older.rows.map(({ capability }) => capability)).toEqual(["pair.reveal", "pair.hello"]);
    expect((await page("?order=oldest&limit=1")).rows.map(({ capability }) => capability)).toEqual([
      "pair.hello",
    ]);
    expect(await answer(routes.meshAudit(local("GET", "/mesh/audit?order=sideways"), {}))).toEqual({
      status: 400,
      body: { error: "order is oldest or newest" },
    });
  });
});
