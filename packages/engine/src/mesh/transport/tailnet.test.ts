import { describe, expect, it } from "vitest";
import { pingFailure } from "./ping.ts";
import { parseStatus, type TailnetStatus } from "./status.ts";
import { createTailnet } from "./tailnet.ts";
import { editedJson, recordedHost, recordedText } from "./testing/recorded.ts";
import type { TailscaleTransport } from "./transport.ts";
import { parseWhoIs, type WhoIs } from "./whois.ts";

function countingTransport() {
  const state = {
    status: parseStatus(recordedText("status-running")) as TailnetStatus,
    whois: parseWhoIs(recordedText("whois-peer")) as WhoIs | null,
    lookups: [] as string[],
    failNext: false,
  };
  const transport: TailscaleTransport = {
    name: "counting",
    status: async () => state.status,
    whois: async (host) => {
      state.lookups.push(host);
      if (state.failNext) {
        state.failNext = false;
        throw new Error("tailscaled hiccup");
      }
      return state.whois;
    },
    ping: async () => pingFailure("unused"),
    serve: async () => ({ serving: false, funnel: [] }),
  };
  return { state, transport };
}

describe("the WhoIs cache", () => {
  it("asks tailscaled once per address and normalizes the address first", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    await tailnet.whois(`${recordedHost.ipv4}:51515`);
    await tailnet.whois(`::ffff:${recordedHost.ipv4}`);
    await tailnet.whois(recordedHost.ipv4);
    expect(state.lookups).toEqual([recordedHost.ipv4]);
  });

  it("shares one lookup between connections that arrive together", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    await Promise.all([tailnet.whois(recordedHost.ipv4), tailnet.whois(recordedHost.ipv4)]);
    expect(state.lookups).toHaveLength(1);
  });

  it("keeps identities while the status says nothing changed", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    await tailnet.status();
    await tailnet.whois(recordedHost.ipv4);
    state.status = parseStatus(recordedText("status-direct"));
    await tailnet.status();
    await tailnet.whois(recordedHost.ipv4);
    expect(state.lookups).toHaveLength(1);
  });

  it("forgets identities when the status shows a changed netmap", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    await tailnet.status();
    await tailnet.whois(recordedHost.ipv4);
    state.status = parseStatus(
      editedJson("status-running", (json) => {
        for (const peer of Object.values(json.Peer as Record<string, Record<string, unknown>>)) {
          peer.Expired = true;
        }
      }),
    );
    await tailnet.status();
    await tailnet.whois(recordedHost.ipv4);
    expect(state.lookups).toHaveLength(2);
  });

  it("caches a not-a-peer answer the same way and never caches a failure", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    state.failNext = true;
    await expect(tailnet.whois(recordedHost.ipv4)).rejects.toThrow("hiccup");
    state.whois = null;
    await expect(tailnet.whois(recordedHost.ipv4)).resolves.toBeNull();
    await expect(tailnet.whois(recordedHost.ipv4)).resolves.toBeNull();
    expect(state.lookups).toHaveLength(2);
  });

  it("looks again once an entry is older than the maximum age", async () => {
    const { state, transport } = countingTransport();
    let clock = 0;
    const tailnet = createTailnet(transport, { whoisMaxAgeMs: 1_000, now: () => clock });
    await tailnet.whois(recordedHost.ipv4);
    clock = 999;
    await tailnet.whois(recordedHost.ipv4);
    clock = 1_000;
    await tailnet.whois(recordedHost.ipv4);
    expect(state.lookups).toHaveLength(2);
  });

  it("refuses an address that is not an IP before asking anything", async () => {
    const { state, transport } = countingTransport();
    const tailnet = createTailnet(transport);
    await expect(tailnet.whois("house.tail5e7d00.ts.net")).rejects.toThrow(/not an IP/);
    expect(state.lookups).toEqual([]);
  });
});
