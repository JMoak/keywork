import { describe, expect, it } from "vitest";
import { screenUdpPorts } from "../listener/ports.ts";
import { parseStatus, type TailnetStatus } from "../transport/status.ts";
import { recordedHost, recordedText } from "../transport/testing/recorded.ts";
import { checkMeshPolicy } from "./check.ts";
import { PolicyTextError, parseHuJson } from "./hujson.ts";
import { parcelsOf } from "./nodes.ts";
import type { PolicyReport } from "./verify.ts";
import { policyReportLines } from "./words.ts";

const ports = { tcp: 47800, udp: screenUdpPorts };

const steadSnippet = `{
  // stead: consoles stay untagged; headless hosts and workshops carry the stead tags
  "tagOwners": {
    "tag:stead-host": ["autogroup:admin"],
    "tag:stead-workshop": ["autogroup:admin"],
  },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["tcp:47800", "udp:47810-47829"] },
    { "src": ["autogroup:member"], "dst": ["tag:stead-host", "tag:stead-workshop"], "ip": ["tcp:47800", "udp:47810-47829"] },
    /* hosts reach workshops and each other */
    { "src": ["tag:stead-host"], "dst": ["tag:stead-workshop", "tag:stead-host"], "ip": ["tcp:47800", "udp:47810-47829"] },
  ],
}`;

function recordedStatus(): TailnetStatus {
  return parseStatus(recordedText("status-running"));
}

function withTaggedHost(status: TailnetStatus, tags = ["tag:stead-host"]): TailnetStatus {
  return { ...status, peers: status.peers.map((peer) => ({ ...peer, tags })) };
}

function check(text: string, status = recordedStatus()): PolicyReport {
  return checkMeshPolicy({ text, status, ports });
}

describe("parseHuJson", () => {
  it("drops comments and trailing commas but keeps slashes inside strings", () => {
    const text = `{
      // a line comment
      "url": "https://example.com/cap/mesh", /* a block
      comment */ "list": [1, 2,],
    }`;
    expect(parseHuJson(text)).toEqual({ url: "https://example.com/cap/mesh", list: [1, 2] });
  });

  it("says in words when the text is not a policy", () => {
    expect(() => parseHuJson("{ grants: [")).toThrow(PolicyTextError);
    expect(() => check('{ "grants": "all" }')).toThrow(
      /does not read as a tailnet policy at grants/,
    );
  });
});

describe("checkMeshPolicy", () => {
  it("finds every lane open between the keeper's own untagged machines under the stead snippet", () => {
    const report = check(steadSnippet);
    expect(report.controlPlane).toBe("tailscale");
    expect(report.snippet).toBeNull();
    expect(policyReportLines(report)).toEqual([
      "policy: stead ports tcp 47800 and udp 47810-47829 on a Tailscale control plane, the house and 1 parcel",
      "house house → host: tcp 47800 allowed by grants[0]; udp 47810-47829 allowed by grants[0]",
      "host → house house: tcp 47800 allowed by grants[0]; udp 47810-47829 allowed by grants[0]",
      "policy: every lane is open on the stead ports and every tag has an owner; nothing to paste",
    ]);
  });

  it("names the missing rule back from a tagged host to the house as a grant to paste", () => {
    const report = check(steadSnippet, withTaggedHost(recordedStatus()));
    const [out, back] = report.lanes;
    expect(out?.flows.map(({ allowedBy }) => allowedBy)).toEqual([["grants[1]"], ["grants[1]"]]);
    expect(back?.flows.every(({ allowedBy }) => allowedBy.length === 0)).toBe(true);
    expect(report.snippet).toEqual({
      grants: [
        {
          src: ["tag:stead-host"],
          dst: ["keeper@example.com"],
          ip: ["tcp:47800", "udp:47810-47829"],
        },
      ],
    });
    const lines = policyReportLines(report);
    expect(lines).toContain(
      "host → house house: tcp 47800 not allowed; udp 47810-47829 not allowed",
    );
    expect(lines).toContain("tags: tag:stead-host on host is owned in tagOwners");
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual(report.snippet);
  });

  it("reads legacy acls with comma ports and proto, and names only the ports still missing", () => {
    const acls = `{ "acls": [
      { "action": "accept", "src": ["keeper@example.com"], "dst": ["keeper@example.com:47800,47810-47819"] },
      { "action": "accept", "src": ["keeper@example.com"], "dst": ["keeper@example.com:47820-47829"], "proto": "tcp" },
    ] }`;
    const [out] = check(acls).lanes;
    expect(out?.flows).toEqual([
      {
        protocol: "tcp",
        ports: { first: 47800, last: 47800 },
        allowedBy: ["acls[0]"],
        missing: [],
      },
      {
        protocol: "udp",
        ports: screenUdpPorts,
        allowedBy: ["acls[0]"],
        missing: [{ first: 47820, last: 47829 }],
      },
    ]);
    expect(policyReportLines(check(acls))[1]).toBe(
      "house house → host: tcp 47800 allowed by acls[0]; udp 47810-47829 allowed in part by acls[0], missing 47820-47829",
    );
    expect(check(acls).snippet?.grants).toEqual([
      { src: ["keeper@example.com"], dst: ["keeper@example.com"], ip: ["udp:47820-47829"] },
    ]);
  });

  it("resolves groups, hosts and prefixes, and refuses a deny-everything policy", () => {
    const policy = `{
      "groups": { "group:keepers": ["keeper@example.com"] },
      "hosts": { "spark": "${recordedHost.ipv4}" },
      "grants": [
        { "src": ["group:keepers"], "dst": ["spark"], "ip": ["*"] },
        { "src": ["100.64.0.0/10"], "dst": ["autogroup:member"], "ip": ["tcp:*", "udp:47810-47829"] },
      ],
    }`;
    expect(check(policy).snippet).toBeNull();
    const closed = check("{}");
    expect(
      closed.lanes.flatMap(({ flows }) => flows).every(({ missing }) => missing.length > 0),
    ).toBe(true);
    expect(closed.snippet?.grants).toHaveLength(1);
  });

  it("asks for a tagOwners entry when a parcel carries a tag nobody owns", () => {
    const report = check(
      steadSnippet,
      withTaggedHost(recordedStatus(), ["tag:stead-workshop", "tag:gpu"]),
    );
    expect(report.tags).toContainEqual({ tag: "tag:gpu", node: "host", owned: false });
    expect(report.snippet?.tagOwners).toEqual({ "tag:gpu": ["autogroup:admin"] });
    expect(policyReportLines(report)).toContain(
      "tags: tag:gpu on host has no tagOwners entry, so the control plane will not keep it",
    );
  });

  it("does not count rules it cannot resolve, routed grants, and says so", () => {
    const policy = `{ "grants": [
      { "src": ["autogroup:admin"], "dst": ["*"], "ip": ["*"] },
      { "src": ["*"], "dst": ["*"], "ip": ["*"], "via": ["tag:router"] },
    ] }`;
    const report = check(policy);
    expect(report.snippet).not.toBeNull();
    expect(report.cautions).toEqual([
      "grants[0] names autogroup:admin, which this machine cannot resolve from the tailnet status; it was not counted",
      "grants[1] routes via a router, so it opens no lane between machines",
    ]);
  });

  it("warns when the house itself is tagged", () => {
    const status = recordedStatus();
    const self = status.self;
    if (self === null) throw new Error("the fixture has no Self");
    const report = check(steadSnippet, { ...status, self: { ...self, tags: ["tag:stead-host"] } });
    expect(report.cautions.some((caution) => caution.includes("wrong for a house"))).toBe(true);
  });
});

describe("parcelsOf", () => {
  it("keeps to the paired parcels once there are any, and skips shared-in nodes", () => {
    const status = recordedStatus();
    expect(parcelsOf(status).map(({ name }) => name)).toEqual(["host"]);
    expect(parcelsOf(status, ["nSomeoneElse"])).toEqual([]);
    const shared = { ...status, peers: status.peers.map((peer) => ({ ...peer, sharee: true })) };
    expect(parcelsOf(shared)).toEqual([]);
  });
});
