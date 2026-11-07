import { describe, expect, it } from "vitest";
import { parseStatus, type TailnetNode, type TailnetStatus } from "../transport/status.ts";
import { recordedHost, recordedHouse, recordedText } from "../transport/testing/recorded.ts";
import { readPeerManifest, takeCensus } from "./census.ts";
import { type HelloFetch, meshHello } from "./hello.ts";
import { buildManifest, type NodeManifest, type NodeRole } from "./manifest.ts";

const port = 47800;
const recorded = parseStatus(recordedText("status-running"));
const [recordedPeer] = recorded.peers;

function withPeers(...changes: Partial<TailnetNode>[]): TailnetStatus {
  if (recordedPeer === undefined) throw new Error("the recorded status has a peer");
  return { ...recorded, peers: changes.map((change) => ({ ...recordedPeer, ...change })) };
}

function manifestWith(roles: NodeRole[]): Promise<NodeManifest> {
  return buildManifest({
    version: "0.4.0",
    roles,
    capabilities: ["exec"],
    gpus: async () => [],
    machine: () => ({ name: "host", os: "linux", arch: "x64" }),
    now: () => new Date("2026-11-05T12:00:00.000Z"),
  });
}

function fakeNodes(answers: Readonly<Record<string, () => unknown>>) {
  const asked: string[] = [];
  const fetchFn: HelloFetch = async (url) => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new Error(`connect ECONNREFUSED ${url}`);
    const body = answer();
    return body instanceof Response ? body : Response.json(body);
  };
  return { fetchFn, asked };
}

const hostEndpoint = `http://${recordedHost.ipv4}:${port}`;

describe("takeCensus", () => {
  it("lists every peer with identity and lane, and reads manifests from paired peers only", async () => {
    const hostManifest = await manifestWith(["host", "reachable"]);
    const { fetchFn, asked } = fakeNodes({
      [`${hostEndpoint}/mesh/hello`]: () => meshHello("0.4.0", "claimed"),
      [`${hostEndpoint}/mesh/manifest`]: () => hostManifest,
      "http://100.88.0.2:47800/mesh/hello": () => meshHello("0.4.0", "unclaimed"),
      "http://100.88.0.2:47800/mesh/manifest": () => hostManifest,
      "http://[fd7a:115c:a1e0::5]:47800/mesh/hello": () => meshHello("0.3.9", "unclaimed"),
    });
    const census = await takeCensus({
      tailnet: {
        status: async () =>
          withPeers(
            {},
            { stableId: "nStranger", tailscaleIPs: ["100.88.0.2"] },
            { stableId: "nAsleep", tailscaleIPs: ["100.88.0.3"], online: false },
            { stableId: "nSilent", tailscaleIPs: ["100.88.0.4"] },
            { stableId: "nSixOnly", tailscaleIPs: ["100.88.0.5", "fd7a:115c:a1e0::5"] },
          ),
      },
      port,
      fetch: fetchFn,
      pairs: () => [
        { peerStableId: recordedHost.stableId, endpoint: hostEndpoint },
        { peerStableId: "nAsleep", endpoint: "http://100.88.0.3:47800" },
      ],
    });
    expect(
      census.peers.map(({ stableId, node, manifest, endpoint }) => [
        stableId,
        node?.pairing ?? null,
        manifest,
        endpoint,
      ]),
    ).toEqual([
      [recordedHost.stableId, "claimed", { roles: ["host", "reachable"] }, hostEndpoint],
      ["nStranger", "unclaimed", null, "http://100.88.0.2:47800"],
      ["nAsleep", null, null, "http://100.88.0.3:47800"],
      ["nSilent", null, null, undefined],
      ["nSixOnly", "unclaimed", null, "http://[fd7a:115c:a1e0::5]:47800"],
    ]);
    expect(census.peers[0]).toMatchObject({
      machine: "host",
      os: "linux",
      path: { kind: "derp", region: "ord" },
      user: { loginName: "keeper@example.com" },
    });
    expect(census.peers.map((peer) => "endpoint" in peer)).toEqual([true, true, true, false, true]);
    expect(asked).not.toContain("http://100.88.0.2:47800/mesh/manifest");
    expect(asked.filter((url) => url.includes("100.88.0.3"))).toEqual([]);
  });

  it("keeps a paired peer whose manifest is refused or malformed without a manifest", async () => {
    for (const manifest of [
      () => new Response("{}", { status: 403 }),
      () => ({ roles: ["host"] }),
    ]) {
      const { fetchFn } = fakeNodes({
        [`${hostEndpoint}/mesh/hello`]: () => meshHello("0.4.0", "claimed"),
        [`${hostEndpoint}/mesh/manifest`]: manifest,
      });
      const census = await takeCensus({
        tailnet: { status: async () => withPeers({}) },
        port,
        fetch: fetchFn,
        pairs: () => [{ peerStableId: recordedHost.stableId, endpoint: null }],
      });
      expect(census.peers[0]).toMatchObject({ node: { pairing: "claimed" }, manifest: null });
      expect(census.peers[0]?.endpoint).toBe(hostEndpoint);
    }
  });

  it("describes this machine from its own hello and the manifest it publishes", async () => {
    const houseEndpoint = `http://${recordedHouse.ipv4}:${port}`;
    const { fetchFn } = fakeNodes({
      [`${houseEndpoint}/mesh/hello`]: () => meshHello("0.4.0", "claimed"),
    });
    const census = await takeCensus({
      tailnet: { status: async () => withPeers() },
      port,
      fetch: fetchFn,
      pairs: () => [],
      selfManifest: () => manifestWith(["console"]),
    });
    expect(census).toEqual({
      self: expect.objectContaining({
        stableId: recordedHouse.stableId,
        machine: "house",
        addresses: [recordedHouse.ipv4, recordedHouse.ipv6],
        node: { product: "keywork", version: "0.4.0", pairing: "claimed" },
        manifest: { roles: ["console"] },
        endpoint: houseEndpoint,
      }),
      peers: [],
    });
    const anonymous = await takeCensus({
      tailnet: { status: async () => ({ ...withPeers(), self: null }) },
      port,
      fetch: fetchFn,
      pairs: () => [],
    });
    expect(anonymous.self).toBeNull();
  });
});

describe("readPeerManifest", () => {
  it("parses a manifest and answers null for anything else", async () => {
    const manifest = await manifestWith(["host"]);
    const reading = (answer: () => unknown) =>
      readPeerManifest(hostEndpoint, {
        fetch: fakeNodes({ [`${hostEndpoint}/mesh/manifest`]: answer }).fetchFn,
      });
    expect(await reading(() => manifest)).toEqual(manifest);
    expect(await reading(() => new Response("no", { status: 404 }))).toBeNull();
    expect(await reading(() => new Response("not json"))).toBeNull();
    expect(await readPeerManifest(hostEndpoint, { fetch: fakeNodes({}).fetchFn })).toBeNull();
  });
});
