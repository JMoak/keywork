import { describe, expect, it } from "vitest";
import { parsePingJson, parsePingOutput } from "./ping.ts";
import { parseServeConfig } from "./serve-config.ts";
import { isRunning, parseStatus, statusFingerprint, userOf } from "./status.ts";
import { TailscaleFormatError } from "./tailscale-json.ts";
import {
  editedJson,
  recordedHost,
  recordedHouse,
  recordedKeeper,
  recordedText,
} from "./testing/recorded.ts";
import { isSharedIn, isTaggedNode, parseWhoIs } from "./whois.ts";

describe("parseStatus on the recorded status of the house", () => {
  const status = parseStatus(recordedText("status-running"));

  it("reads the backend state, TUN mode, version and the node's own addresses", () => {
    expect(isRunning(status)).toBe(true);
    expect(status.tun).toBe(true);
    expect(status.version).toBe("1.104.1-t7f4efe814-g8da26756c");
    expect(status.tailscaleIPs).toEqual([recordedHouse.ipv4, recordedHouse.ipv6]);
    expect(status.self?.stableId).toBe(recordedHouse.stableId);
    expect(status.tailnet).toEqual({
      name: "keeper@example.com",
      stableId: "TSteadE5f6CNTRL",
      magicDNSSuffix: "tail5e7d00.ts.net",
    });
  });

  it("reads each peer's identity and path fields", () => {
    expect(status.peers).toHaveLength(1);
    const [host] = status.peers;
    expect(host).toMatchObject({
      stableId: recordedHost.stableId,
      hostName: "host",
      os: "linux",
      userId: recordedKeeper.userId,
      tailscaleIPs: [recordedHost.ipv4, recordedHost.ipv6],
      tags: [],
      curAddr: "",
      relay: "ord",
      peerRelay: "",
      online: true,
      expired: false,
      sharee: false,
      inNetworkMap: true,
    });
    expect(host && userOf(status, host)).toEqual({
      id: recordedKeeper.userId,
      loginName: recordedKeeper.loginName,
      displayName: recordedKeeper.displayName,
    });
  });

  it("keeps an int64 user id that a double cannot hold exactly", () => {
    const text = recordedText("status-running").replaceAll(
      "7000000000000001",
      "9223372036854770001",
    );
    const [host] = parseStatus(text).peers;
    expect(host?.userId).toBe("9223372036854770001");
  });

  it("reads a stopped node with no peers, self or addresses", () => {
    const stopped = parseStatus(
      JSON.stringify({ BackendState: "Stopped", TUN: true, TailscaleIPs: null, Peer: null }),
    );
    expect(stopped).toMatchObject({
      backendState: "Stopped",
      tailscaleIPs: [],
      peers: [],
      self: null,
    });
    expect(isRunning(stopped)).toBe(false);
  });

  it("treats a backend state it has never seen as not running", () => {
    const future = parseStatus(JSON.stringify({ BackendState: "Hibernating", TUN: true }));
    expect(future.backendState).toBe("Unknown");
    expect(isRunning(future)).toBe(false);
  });

  it("tolerates display fields changing shape but not identity fields", () => {
    const loose = editedJson("status-running", (json) => {
      json.Self = { ...json.Self, HostName: 42, OS: null };
    });
    expect(parseStatus(loose).self).toMatchObject({ hostName: "", os: "" });
    const broken = editedJson("status-running", (json) => {
      json.Self = { ...json.Self, Tags: "tag:agent-host" };
    });
    expect(() => parseStatus(broken)).toThrow(TailscaleFormatError);
  });

  it("fails loudly on output that is not JSON", () => {
    expect(() => parseStatus("Tailscale is stopped.")).toThrow(/not JSON/);
  });

  it("changes its fingerprint when identity changes and not when traffic does", () => {
    const direct = parseStatus(recordedText("status-direct"));
    expect(statusFingerprint(direct)).toBe(statusFingerprint(status));
    const tagged = editedJson("status-running", (json) => {
      const peers = json.Peer as Record<string, Record<string, unknown>>;
      for (const peer of Object.values(peers)) peer.Tags = ["tag:agent-host"];
    });
    expect(statusFingerprint(parseStatus(tagged))).not.toBe(statusFingerprint(status));
  });
});

describe("parseWhoIs on recorded answers", () => {
  it("reads the peer's stable node id, human, addresses and empty capability map", () => {
    const whois = parseWhoIs(recordedText("whois-peer"));
    expect(whois.node).toMatchObject({
      stableId: recordedHost.stableId,
      computedName: "host",
      os: "linux",
      userId: recordedKeeper.userId,
      sharerId: null,
      addresses: [recordedHost.ipv4, recordedHost.ipv6],
      tags: [],
      online: true,
      expired: false,
    });
    expect(whois.user).toEqual({
      id: recordedKeeper.userId,
      loginName: recordedKeeper.loginName,
      displayName: recordedKeeper.displayName,
    });
    expect(whois.capMap).toEqual({});
    expect(isTaggedNode(whois)).toBe(false);
    expect(isSharedIn(whois)).toBe(false);
  });

  it("answers the same node for its IPv6 address", () => {
    expect(parseWhoIs(recordedText("whois-peer-v6")).node.stableId).toBe(recordedHost.stableId);
  });

  it("reads tags, a sharer, expiry and a capability map", () => {
    const text = editedJson("whois-peer", (json) => {
      json.Node = { ...json.Node, Tags: ["tag:agent-host"], Sharer: 99, Expired: true };
      json.CapMap = {
        "example.com/cap/mesh": [{ role: "console" }],
        "example.com/cap/empty": null,
      };
    });
    const whois = parseWhoIs(text);
    expect(isTaggedNode(whois)).toBe(true);
    expect(whois.node.sharerId).toBe("99");
    expect(whois.node.expired).toBe(true);
    expect(whois.capMap).toEqual({
      "example.com/cap/mesh": [{ role: "console" }],
      "example.com/cap/empty": [],
    });
  });

  it("refuses an answer with no stable node id", () => {
    const text = editedJson("whois-peer", (json) => {
      json.Node = { ...json.Node, StableID: "" };
    });
    expect(() => parseWhoIs(text)).toThrow(TailscaleFormatError);
  });
});

describe("ping results", () => {
  it.each([
    [
      "pong from host (100.88.77.66) via 192.168.1.30:41641 in 2ms",
      { endpoint: "192.168.1.30:41641", peerRelay: "", derpRegion: "", latencyMs: 2 },
    ],
    [
      "pong from host (100.88.77.66) via DERP(ord) in 45ms",
      { endpoint: "", peerRelay: "", derpRegion: "ord", latencyMs: 45 },
    ],
    [
      "pong from host (100.88.77.66) via peer-relay(198.51.100.4:7777:vni:12) in 1.5s",
      { endpoint: "", peerRelay: "198.51.100.4:7777:vni:12", derpRegion: "", latencyMs: 1500 },
    ],
    [
      "pong from host (fd7a:115c:a1e0::5841:4d42) via [2001:db8::10]:41641 in 750µs",
      { endpoint: "[2001:db8::10]:41641", peerRelay: "", derpRegion: "", latencyMs: 0.75 },
    ],
  ])("reads the CLI line %s", (line, expected) => {
    expect(parsePingOutput(`${line}\n`)).toEqual({
      ok: true,
      nodeName: "host",
      nodeIP: line.includes("fd7a") ? "fd7a:115c:a1e0::5841:4d42" : "100.88.77.66",
      ...expected,
    });
  });

  it("keeps the last reply when the CLI pinged more than once", () => {
    const output = [
      "pong from host (100.88.77.66) via DERP(ord) in 40ms",
      "pong from host (100.88.77.66) via 192.168.1.30:41641 in 2ms",
    ].join("\n");
    expect(parsePingOutput(output)).toMatchObject({ ok: true, endpoint: "192.168.1.30:41641" });
  });

  it("reports CLI output without a pong as a failure", () => {
    expect(parsePingOutput('ping "100.88.77.66" timed out\n')).toEqual({
      ok: false,
      error: 'ping "100.88.77.66" timed out',
    });
  });

  it("reads the LocalAPI ping result", () => {
    const reply = JSON.stringify({
      IP: "100.88.77.66",
      NodeIP: "100.88.77.66",
      NodeName: "host",
      LatencySeconds: 0.002,
      Endpoint: "192.168.1.30:41641",
      DERPRegionID: 0,
      DERPRegionCode: "",
      PeerRelay: "",
    });
    expect(parsePingJson(reply)).toMatchObject({
      ok: true,
      latencyMs: 2,
      endpoint: "192.168.1.30:41641",
    });
    expect(parsePingJson(JSON.stringify({ Err: "no matching peer" }))).toEqual({
      ok: false,
      error: "no matching peer",
    });
  });
});

describe("parseServeConfig", () => {
  it("reads the empty config this node answers with as not serving and no Funnel", () => {
    expect(parseServeConfig("{}\n")).toEqual({ serving: false, funnel: [] });
    expect(parseServeConfig("")).toEqual({ serving: false, funnel: [] });
  });

  it("finds Funnel in the node config and in foreground sessions", () => {
    const config = {
      TCP: { "443": { HTTPS: true } },
      AllowFunnel: { "house.tail5e7d00.ts.net:443": true, "house.tail5e7d00.ts.net:8443": false },
      Foreground: {
        session: { Web: { "x:10000": {} }, AllowFunnel: { "house.tail5e7d00.ts.net:10000": true } },
      },
    };
    expect(parseServeConfig(JSON.stringify(config))).toEqual({
      serving: true,
      funnel: ["house.tail5e7d00.ts.net:443", "house.tail5e7d00.ts.net:10000"],
    });
  });
});
