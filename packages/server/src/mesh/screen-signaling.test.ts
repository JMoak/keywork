import { describe, expect, it } from "vitest";
import {
  isTailnetHostCandidate,
  parseIceCandidate,
  screenSignalingVersion,
  screenSignalSchema,
} from "./screen-signaling.ts";

const ids = { v: screenSignalingVersion, sessionId: "sess-01HZY", grantId: "grant:7f3a" };

const tailnetHost = "candidate:842163049 1 udp 1677729535 100.88.77.66 47812 typ host generation 0";
const tailnetHostV6 =
  "candidate:842163050 1 udp 1677729535 fd7a:115c:a1e0::5841:4d42 47813 typ host generation 0";

function sdpWith(...candidates: string[]): string {
  return [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=fingerprint:sha-256 AB:CD:EF",
    ...candidates.map((candidate) => `a=${candidate}`),
    "",
  ].join("\r\n");
}

describe("parseIceCandidate", () => {
  it("reads the fields of an RTCIceCandidate string", () => {
    expect(parseIceCandidate(tailnetHost)).toEqual({
      foundation: "842163049",
      component: 1,
      protocol: "udp",
      priority: 1677729535,
      address: "100.88.77.66",
      port: 47812,
      type: "host",
    });
  });

  it("answers null for something that is not a candidate", () => {
    expect(parseIceCandidate("")).toBeNull();
    expect(parseIceCandidate("candidate:1 1 udp x 100.88.77.66 1 typ host")).toBeNull();
  });
});

describe("the candidate filter", () => {
  it.each([tailnetHost, tailnetHostV6, `a=${tailnetHost}`])("keeps %s", (candidate) => {
    expect(isTailnetHostCandidate(candidate)).toBe(true);
  });

  it.each([
    ["a LAN host", "candidate:1 1 udp 2122260223 192.168.1.30 51000 typ host"],
    ["an mDNS name", "candidate:1 1 udp 2122260223 0b5c1e2a-6c3f.local 51000 typ host"],
    [
      "a reflexive address",
      "candidate:2 1 udp 1686052607 100.88.77.66 51000 typ srflx raddr 0.0.0.0 rport 0",
    ],
    [
      "a TURN relay",
      "candidate:3 1 udp 41885439 100.88.77.66 51000 typ relay raddr 0.0.0.0 rport 0",
    ],
    ["a TCP candidate", "candidate:4 1 tcp 1518280447 100.88.77.66 9 typ host tcptype active"],
    ["a public address", "candidate:5 1 udp 2122260223 203.0.113.10 51000 typ host"],
  ])("drops %s", (_what, candidate) => {
    expect(isTailnetHostCandidate(candidate)).toBe(false);
  });
});

describe("screenSignalSchema", () => {
  it("accepts an offer, an answer and a candidate on the tailnet", () => {
    const offer = { kind: "offer", ...ids, sdp: sdpWith(tailnetHost) };
    const answer = { kind: "answer", ...ids, sdp: sdpWith() };
    const candidate = {
      kind: "candidate",
      ...ids,
      candidate: tailnetHostV6,
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    };
    for (const signal of [offer, answer, candidate]) {
      expect(screenSignalSchema.parse(signal)).toEqual(signal);
    }
  });

  it("refuses a candidate off the tailnet", () => {
    const signal = {
      kind: "candidate",
      ...ids,
      candidate: "candidate:1 1 udp 2122260223 192.168.1.30 51000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: null,
    };
    expect(screenSignalSchema.safeParse(signal).success).toBe(false);
  });

  it("refuses an offer whose SDP carries a candidate off the tailnet", () => {
    const sdp = sdpWith(tailnetHost, "candidate:9 1 udp 2122260223 192.168.1.30 51000 typ host");
    expect(screenSignalSchema.safeParse({ kind: "offer", ...ids, sdp }).success).toBe(false);
  });

  it("requires a grant id, a session id and the current version", () => {
    const sdp = sdpWith();
    expect(screenSignalSchema.safeParse({ kind: "offer", ...ids, grantId: "", sdp }).success).toBe(
      false,
    );
    expect(
      screenSignalSchema.safeParse({ kind: "offer", ...ids, sessionId: "../etc", sdp }).success,
    ).toBe(false);
    expect(screenSignalSchema.safeParse({ kind: "offer", ...ids, v: 2, sdp }).success).toBe(false);
    expect(screenSignalSchema.safeParse({ kind: "bye", ...ids }).success).toBe(false);
  });
});

describe("the control scope on the relay", () => {
  it("carries a control request, a grant with control over view, and control state changes", () => {
    const { grantId: _view, ...session } = ids;
    expect(
      screenSignalSchema.safeParse({ kind: "request", ...session, scope: "control" }).success,
    ).toBe(true);
    const granted = {
      kind: "granted",
      ...ids,
      token: "t".repeat(43),
      expiresAt: "2026-11-06T10:00:00.000Z",
      displays: [],
      current: "1",
      control: { grantId: "grant:c1", expiresAt: "2026-11-06T09:30:00.000Z" },
    };
    expect(screenSignalSchema.safeParse(granted).success).toBe(true);
    for (const state of ["granted", "paused", "resumed", "revoked"]) {
      expect(screenSignalSchema.safeParse({ kind: "control", ...ids, state }).success).toBe(true);
    }
    expect(
      screenSignalSchema.safeParse({ kind: "denied", ...session, reason: "agent-control" }).success,
    ).toBe(true);
  });

  it("refuses a scope or a control state it does not know", () => {
    const { grantId: _view, ...session } = ids;
    expect(
      screenSignalSchema.safeParse({ kind: "request", ...session, scope: "files" }).success,
    ).toBe(false);
    expect(
      screenSignalSchema.safeParse({ kind: "control", ...ids, state: "forever" }).success,
    ).toBe(false);
  });
});
