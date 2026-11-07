import type { GrantEvent, MeshCensus, MeshListenerEvent, PairingEvent } from "@keywork/engine";
import { describe, expect, it, vi } from "vitest";
import { type BusEnvelope, EventLog } from "./events.ts";
import {
  lanesChanged,
  lanesHeldThroughIdle,
  meshEventsInto,
  settledCensus,
  watchLanes,
} from "./mesh-events.ts";

function recorded(): { log: EventLog; envelopes: BusEnvelope[] } {
  const log = new EventLog({ now: () => new Date("2026-11-05T12:00:00.000Z") });
  const envelopes: BusEnvelope[] = [];
  log.subscribe((envelope) => envelopes.push(envelope));
  return { log, envelopes };
}

const call = {
  type: "tool-call",
  callId: "c1",
  name: "bash",
  arguments: { command: "ls" },
} as const;

describe("meshEventsInto", () => {
  it("stamps listener events as mesh.listener with the change named, and keeps callers off the wire", () => {
    const { log, envelopes } = recorded();
    const sinks = meshEventsInto(log);
    const events: MeshListenerEvent[] = [
      { type: "mesh.listener.bound", address: "100.101.102.103", port: 47800 },
      { type: "mesh.listener.idle", reason: "not-running" },
      { type: "mesh.caller.denied", address: "100.1.2.3", reason: "not-a-peer", detail: "404" },
    ];
    for (const event of events) sinks.listener(event);
    expect(envelopes.map(({ sessionId, type, payload }) => [sessionId, type, payload])).toEqual([
      ["", "mesh.listener", { change: "bound", address: "100.101.102.103", port: 47800 }],
      ["", "mesh.listener", { change: "idle", reason: "not-running" }],
    ]);
  });

  it("splits pairing events into mesh.pairing and mesh.pair", () => {
    const { log, envelopes } = recorded();
    const sinks = meshEventsInto(log);
    const events: PairingEvent[] = [
      { type: "mesh.pairing.refused", peerStableId: "nStranger", reason: "not-the-owner" },
      { type: "mesh.pairing.aborted", pairingId: "p1", reason: "sas-mismatch" },
      { type: "mesh.pair.removed", pairId: "pair-1", peerStableId: "nHost", by: "keeper" },
    ];
    for (const event of events) sinks.pairing(event);
    expect(envelopes.map(({ type, payload }) => [type, payload])).toEqual([
      ["mesh.pairing", { change: "refused", peerStableId: "nStranger", reason: "not-the-owner" }],
      ["mesh.pairing", { change: "aborted", pairingId: "p1", reason: "sas-mismatch" }],
      ["mesh.pair", { change: "removed", pairId: "pair-1", peerStableId: "nHost", by: "keeper" }],
    ]);
  });

  it("stamps a remote tool call as mesh.walked and the rest of the grant events by change", () => {
    const { log, envelopes } = recorded();
    const sinks = meshEventsInto(log);
    const origin = { kind: "mesh", creature: "pip", node: "nHouse" } as const;
    const events: GrantEvent[] = [
      { type: "mesh.tool.call", origin, grantId: "g1", call, rules: [] },
      { type: "mesh.grant.revoked", grantId: "g1", by: "keeper" },
      { type: "mesh.grant.refused", issuer: "nStranger", reason: "unknown-issuer" },
      {
        type: "mesh.tool.finished",
        origin,
        grantId: "g1",
        callId: "c1",
        outcome: { verdict: "allowed", output: "ok", isError: false, reason: "allowed" },
      },
    ];
    for (const event of events) sinks.grants(event);
    expect(envelopes.map(({ type, payload }) => [type, payload])).toEqual([
      ["mesh.walked", { origin, grantId: "g1", call, rules: [] }],
      ["mesh.grant", { change: "revoked", grantId: "g1", by: "keeper" }],
      ["mesh.grant", { change: "refused", issuer: "nStranger", reason: "unknown-issuer" }],
    ]);
  });
});

describe("the lane watch", () => {
  const direct = { kind: "direct", endpoint: "192.168.4.58:41641" } as const;
  const derp = { kind: "derp", region: "ord" } as const;

  it("names only the peers whose lane moved, never a joiner or a direct endpoint's new port", () => {
    expect(
      lanesChanged(
        [
          { stableId: "nSpark", path: derp },
          { stableId: "nLab", path: direct },
        ],
        [
          { stableId: "nSpark", path: direct },
          { stableId: "nLab", path: { kind: "direct", endpoint: "192.168.4.9:41642" } },
          { stableId: "nNew", path: { kind: "offline" } },
        ],
      ),
    ).toEqual([{ stableId: "nSpark", path: direct }]);
    expect(
      lanesChanged(
        [{ stableId: "nSpark", path: derp }],
        [{ stableId: "nSpark", path: { kind: "derp", region: "nyc" } }],
      ),
    ).toEqual([{ stableId: "nSpark", path: { kind: "derp", region: "nyc" } }]);
  });

  it("holds an idle peer on its last lane, so a quiet tunnel never reads as a move to its home DERP", () => {
    const held = [{ stableId: "nSpark", path: direct }];
    expect(lanesHeldThroughIdle(held, [{ stableId: "nSpark", path: derp, active: false }])).toEqual(
      held,
    );
    expect(lanesHeldThroughIdle(held, [{ stableId: "nSpark", path: derp, active: true }])).toEqual([
      { stableId: "nSpark", path: derp },
    ]);
    expect(lanesHeldThroughIdle([], [{ stableId: "nSpark", path: derp, active: false }])).toEqual([
      { stableId: "nSpark", path: derp },
    ]);
    expect(
      lanesHeldThroughIdle(held, [
        { stableId: "nSpark", path: { kind: "offline" }, active: false },
      ]),
    ).toEqual([{ stableId: "nSpark", path: { kind: "offline" } }]);
  });

  it("records mesh.peers when a reading after the first moves a lane, and stops when told", async () => {
    vi.useFakeTimers();
    try {
      const { log, envelopes } = recorded();
      const readings = [
        [{ stableId: "nSpark", path: derp }],
        [{ stableId: "nSpark", path: derp }],
        [{ stableId: "nSpark", path: direct }],
      ];
      let reads = 0;
      const stop = watchLanes({
        read: async () => readings[Math.min(reads++, readings.length - 1)] ?? [],
        changed: meshEventsInto(log).lanes,
        everyMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(2500);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads).toBe(3);
      expect(envelopes.map(({ sessionId, type, payload }) => [sessionId, type, payload])).toEqual([
        ["", "mesh.peers", { change: "lanes", peers: [{ stableId: "nSpark", path: direct }] }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the settled census", () => {
  const direct = { kind: "direct", endpoint: "192.168.4.58:41641" } as const;
  const derp = { kind: "derp", region: "ord" } as const;

  it("takes the census again when a candidate peer read idle on a relay, and answers the woken lane", async () => {
    const takes = [
      censusOf({ active: false, path: derp }),
      censusOf({ active: true, path: direct }),
    ];
    let taken = 0;
    const settled = await settledCensus(async () => takes[taken++] ?? censusOf({}));
    expect(taken).toBe(2);
    expect(settled.peers.map(({ path }) => path)).toEqual([direct]);
  });

  it("takes the census once when every relayed peer is busy, offline or never probed", async () => {
    for (const peer of [
      { active: true, path: derp },
      { active: false, path: direct },
      { active: false, online: false, path: { kind: "offline" } as const },
      { active: false, candidate: false, path: derp },
    ]) {
      let taken = 0;
      await settledCensus(async () => {
        taken += 1;
        return censusOf(peer);
      });
      expect(taken).toBe(1);
    }
  });
});

function censusOf(peer: Partial<MeshCensus["peers"][number]>): MeshCensus {
  return {
    self: null,
    peers: [
      {
        stableId: "nSpark",
        machine: "spark-ad4d",
        dnsName: "spark-ad4d.tailnet.ts.net.",
        os: "linux",
        addresses: ["100.85.160.9"],
        tags: [],
        user: null,
        online: true,
        active: false,
        candidate: true,
        path: { kind: "unknown" },
        node: null,
        manifest: null,
        ...peer,
      },
    ],
  };
}
