import { describe, expect, it } from "vitest";
import { pingFailure } from "../transport/ping.ts";
import { parseStatus } from "../transport/status.ts";
import { recordedHost, recordedText } from "../transport/testing/recorded.ts";
import { classifyPath, classifyPing, isRelayed, probePath } from "./path.ts";

const route = { online: true, curAddr: "", relay: "", peerRelay: "" };

describe("classifyPath", () => {
  it("reads the recorded idle peer as reachable over its DERP region", () => {
    const [host] = parseStatus(recordedText("status-running")).peers;
    expect(host && classifyPath(host)).toEqual({ kind: "derp", region: "ord" });
  });

  it("reads the recorded active peer as direct", () => {
    const [host] = parseStatus(recordedText("status-direct")).peers;
    expect(host && classifyPath(host)).toEqual({ kind: "direct", endpoint: "192.168.1.30:41641" });
  });

  it("prefers a direct address, then a peer relay, then DERP", () => {
    const all = {
      ...route,
      curAddr: "203.0.113.5:41641",
      peerRelay: "198.51.100.4:7777:vni:3",
      relay: "nyc",
    };
    expect(classifyPath(all).kind).toBe("direct");
    expect(classifyPath({ ...all, curAddr: "" })).toEqual({
      kind: "peer-relay",
      relay: "198.51.100.4:7777:vni:3",
    });
    expect(classifyPath({ ...all, curAddr: "", peerRelay: "" })).toEqual({
      kind: "derp",
      region: "nyc",
    });
  });

  it("calls an offline peer offline whatever its last path was", () => {
    expect(classifyPath({ ...route, online: false, curAddr: "203.0.113.5:41641" })).toEqual({
      kind: "offline",
    });
  });

  it("says unknown when no path field is set", () => {
    expect(classifyPath(route)).toEqual({ kind: "unknown" });
  });

  it("names the relayed paths", () => {
    expect(isRelayed({ kind: "derp", region: "ord" })).toBe(true);
    expect(isRelayed({ kind: "peer-relay", relay: "x" })).toBe(true);
    expect(isRelayed({ kind: "direct", endpoint: "x" })).toBe(false);
  });
});

describe("the ping probe", () => {
  it("classifies the path a ping took and keeps its latency", () => {
    const reply = {
      ok: true as const,
      nodeName: "host",
      nodeIP: recordedHost.ipv4,
      latencyMs: 45,
      endpoint: "",
      peerRelay: "",
      derpRegion: "ord",
    };
    expect(classifyPing(reply)).toEqual({
      reached: true,
      path: { kind: "derp", region: "ord" },
      latencyMs: 45,
    });
    expect(classifyPing(pingFailure("timed out"))).toEqual({ reached: false, error: "timed out" });
  });

  it("turns a transport failure into an unreached probe", async () => {
    const tailnet = {
      ping: async () => {
        throw new Error("tailscaled went away");
      },
    };
    expect(await probePath(tailnet, recordedHost.ipv4)).toEqual({
      reached: false,
      error: "tailscaled went away",
    });
  });
});
