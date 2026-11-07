import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTailnet, recordedPeerWhois, withStatus } from "../transport/testing/fake-tailnet.ts";
import { recordedHouse } from "../transport/testing/recorded.ts";
import { FunnelEnabledError } from "./serve-posture.ts";
import {
  type MeshListenerEvent,
  startTailnetListener,
  type TailnetBinder,
  type TailnetListener,
  type TailnetListenerOptions,
} from "./tailnet-listener.ts";

const tailnetAddresses = [recordedHouse.ipv4, recordedHouse.ipv6];
const opened: TailnetListener[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((listener) => listener.close()));
});

function harness() {
  const tailnet = fakeTailnet();
  const events: MeshListenerEvent[] = [];
  const requested: string[] = [];
  const local = { addresses: [...tailnetAddresses, "127.0.0.1", "192.168.1.20"] };
  const onLoopback: TailnetBinder = (server: Server, address: string) => {
    requested.push(address);
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
  };
  const start = async (overrides: Partial<TailnetListenerOptions> = {}) => {
    const listener = await startTailnetListener({
      tailnet,
      handle: async (_request, caller) => Response.json({ caller: caller.node.stableId }),
      pollMs: 0,
      localAddresses: () => local.addresses,
      listen: onLoopback,
      onEvent: (event) => events.push(event),
      ...overrides,
    });
    opened.push(listener);
    return listener;
  };
  const ofType = <T extends MeshListenerEvent["type"]>(type: T) =>
    events.filter((event): event is Extract<MeshListenerEvent, { type: T }> => event.type === type);
  return { tailnet, events, requested, local, start, ofType };
}

describe("startTailnetListener", () => {
  it("binds one listener per local tailnet address, IPv4 and IPv6, and nothing else", async () => {
    const { requested, start, ofType } = harness();
    const listener = await start();
    expect(requested).toEqual(tailnetAddresses);
    expect(listener.bound().map(({ address }) => address)).toEqual(tailnetAddresses);
    expect(ofType("mesh.listener.bound").map(({ address }) => address)).toEqual(tailnetAddresses);
  });

  it("never asks the binder for loopback or a LAN address, even when the status lists them", async () => {
    const { tailnet, requested, start } = harness();
    tailnet.current.status = withStatus(tailnet.current.status, {
      tailscaleIPs: ["127.0.0.1", "192.168.1.20", recordedHouse.ipv4],
    });
    await start();
    expect(requested).toEqual([recordedHouse.ipv4]);
  });

  it("refuses to start while Funnel is on and binds nothing", async () => {
    const { tailnet, requested, start } = harness();
    tailnet.current.posture = { serving: true, funnel: ["house.tail5e7d00.ts.net:443"] };
    await expect(start()).rejects.toBeInstanceOf(FunnelEnabledError);
    expect(requested).toEqual([]);
  });

  it("listens only while the backend is Running and rebinds when it returns", async () => {
    const { tailnet, start, ofType } = harness();
    const listener = await start();
    const runningStatus = tailnet.current.status;
    tailnet.current.status = withStatus(runningStatus, { backendState: "Stopped" });
    await listener.refresh();
    expect(listener.bound()).toEqual([]);
    expect(ofType("mesh.listener.unbound").map(({ reason }) => reason)).toEqual([
      "not-running",
      "not-running",
    ]);
    expect(ofType("mesh.listener.idle")).toEqual([
      { type: "mesh.listener.idle", reason: "not-running" },
    ]);
    tailnet.current.status = runningStatus;
    await listener.refresh();
    expect(listener.bound()).toHaveLength(2);
  });

  it("moves to a new tailnet address when the old one goes away", async () => {
    const { tailnet, local, requested, start, ofType } = harness();
    const listener = await start();
    const moved = "100.101.0.9";
    tailnet.current.status = withStatus(tailnet.current.status, {
      tailscaleIPs: [moved, recordedHouse.ipv6],
    });
    local.addresses = [moved, recordedHouse.ipv6];
    await listener.refresh();
    expect(listener.bound().map(({ address }) => address)).toEqual([recordedHouse.ipv6, moved]);
    expect(ofType("mesh.listener.unbound")).toEqual([
      { type: "mesh.listener.unbound", address: recordedHouse.ipv4, reason: "address-gone" },
    ]);
    expect(requested.at(-1)).toBe(moved);
  });

  it("drops every listener when Funnel turns on and comes back once it is off", async () => {
    const { tailnet, start, ofType } = harness();
    const listener = await start();
    tailnet.current.posture = { serving: true, funnel: ["house.tail5e7d00.ts.net:443"] };
    await listener.refresh();
    expect(listener.bound()).toEqual([]);
    expect(ofType("mesh.listener.idle")).toEqual([
      { type: "mesh.listener.idle", reason: "funnel-enabled" },
    ]);
    tailnet.current.posture = { serving: false, funnel: [] };
    await listener.refresh();
    expect(listener.bound()).toHaveLength(2);
  });

  it("starts while tailscaled is unreachable and binds once it answers", async () => {
    const { tailnet, start, ofType } = harness();
    tailnet.current.failStatus = true;
    tailnet.serve = async () => {
      throw new Error("tailscaled is not answering");
    };
    const listener = await start();
    expect(listener.bound()).toEqual([]);
    expect(ofType("mesh.listener.status-failed").length).toBeGreaterThan(0);
    tailnet.current.failStatus = false;
    tailnet.serve = async () => tailnet.current.posture;
    await listener.refresh();
    expect(listener.bound()).toHaveLength(2);
  });

  it("warns once when this node serves with a Tailscale older than the Serve fixes", async () => {
    const { tailnet, start, ofType } = harness();
    tailnet.current.posture = { serving: true, funnel: [] };
    const listener = await start();
    await listener.refresh();
    const warnings = ofType("mesh.listener.serve-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("1.104.1");
    expect(warnings[0]?.message).toContain("1.104.4");
  });

  it("reports a bind that fails and keeps the others", async () => {
    const { start, ofType } = harness();
    const listener = await start({
      listen: async (server, address) => {
        if (address === recordedHouse.ipv6) throw new Error("EADDRNOTAVAIL");
        return new Promise((resolve) =>
          server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
        );
      },
    });
    expect(listener.bound().map(({ address }) => address)).toEqual([recordedHouse.ipv4]);
    expect(ofType("mesh.listener.bind-failed")).toEqual([
      { type: "mesh.listener.bind-failed", address: recordedHouse.ipv6, error: "EADDRNOTAVAIL" },
    ]);
  });

  it("identifies every connection with WhoIs and admits only known peers", async () => {
    const { tailnet, start, ofType } = harness();
    const listener = await start();
    const [first] = listener.bound();
    const url = `http://127.0.0.1:${first?.port}/mesh/hello`;
    const denied = await fetch(url);
    expect(denied.status).toBe(403);
    tailnet.current.identities.set("127.0.0.1", recordedPeerWhois());
    const admitted = await fetch(url);
    expect(await admitted.json()).toEqual({ caller: recordedPeerWhois().node.stableId });
    expect(ofType("mesh.caller.denied")).toEqual([
      expect.objectContaining({ address: "127.0.0.1", reason: "not-a-peer" }),
    ]);
    expect(ofType("mesh.caller.admitted")).toHaveLength(1);
    expect(tailnet.whoisCalls).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  it("closes every listener on close", async () => {
    const { start, ofType } = harness();
    const listener = await start();
    await listener.close();
    expect(listener.bound()).toEqual([]);
    expect(ofType("mesh.listener.unbound").map(({ reason }) => reason)).toEqual([
      "closed",
      "closed",
    ]);
  });
});
