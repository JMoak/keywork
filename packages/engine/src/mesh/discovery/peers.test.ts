import { describe, expect, it } from "vitest";
import { parseStatus, type TailnetNode, type TailnetStatus } from "../transport/status.ts";
import { recordedHost, recordedKeeper, recordedText } from "../transport/testing/recorded.ts";
import { type HelloFetch, meshHello } from "./hello.ts";
import { discoverPeers, tailnetPeers } from "./peers.ts";

const recorded = parseStatus(recordedText("status-running"));
const [recordedPeer] = recorded.peers;

function statusWithPeers(...changes: Partial<TailnetNode>[]): TailnetStatus {
  if (recordedPeer === undefined) throw new Error("the recorded status has a peer");
  return {
    ...recorded,
    peers: changes.map((change, index) => ({
      ...recordedPeer,
      stableId: `n${index}CNTRL`,
      tailscaleIPs: [`100.88.0.${index + 1}`],
      ...change,
    })),
  };
}

describe("tailnetPeers", () => {
  it("lists the recorded peer with its identity, addresses and path", () => {
    expect(tailnetPeers(recorded)).toEqual([
      {
        stableId: recordedHost.stableId,
        machine: "host",
        dnsName: "host.tail5e7d00.ts.net.",
        os: "linux",
        addresses: [recordedHost.ipv4, recordedHost.ipv6],
        tags: [],
        user: {
          id: recordedKeeper.userId,
          loginName: recordedKeeper.loginName,
          displayName: recordedKeeper.displayName,
        },
        online: true,
        active: false,
        candidate: true,
        path: { kind: "derp", region: "ord" },
      },
    ]);
  });

  it("probes only peers that are online, in the netmap, not shared in and not expired", () => {
    const peers = tailnetPeers(
      statusWithPeers(
        {},
        { online: false },
        { inNetworkMap: false },
        { sharee: true },
        { expired: true },
      ),
    );
    expect(peers.map(({ candidate }) => candidate)).toEqual([true, false, false, false, false]);
  });

  it("gives a tagged peer no human", () => {
    const [tagged] = tailnetPeers(statusWithPeers({ tags: ["tag:agent-host"] }));
    expect(tagged?.user).toBeNull();
  });
});

describe("discoverPeers", () => {
  it("asks candidates for /mesh/hello and greys out the rest", async () => {
    const asked: string[] = [];
    const fetchHello: HelloFetch = async (url) => {
      asked.push(url);
      if (url.startsWith("http://100.88.0.1:")) return Response.json(meshHello("0.4.0", "claimed"));
      return new Response("not keywork", { status: 404 });
    };
    const status = statusWithPeers({}, { tailscaleIPs: ["100.88.0.2"] }, { online: false });
    const discovered = await discoverPeers({
      tailnet: { status: async () => status },
      port: 47800,
      fetch: fetchHello,
    });
    expect(discovered.map(({ node }) => node)).toEqual([
      { product: "keywork", version: "0.4.0", pairing: "claimed" },
      null,
      null,
    ]);
    expect(asked).toEqual([
      "http://100.88.0.1:47800/mesh/hello",
      "http://100.88.0.2:47800/mesh/hello",
    ]);
  });
});
