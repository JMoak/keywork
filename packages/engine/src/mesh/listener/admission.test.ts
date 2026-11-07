import { describe, expect, it } from "vitest";
import { recordedPeerWhois } from "../transport/testing/fake-tailnet.ts";
import { recordedHost, recordedKeeper } from "../transport/testing/recorded.ts";
import type { WhoIs } from "../transport/whois.ts";
import { admit, identifyCaller } from "./admission.ts";

function whoisWith(node: Partial<WhoIs["node"]>): WhoIs {
  const whois = recordedPeerWhois();
  return { ...whois, node: { ...whois.node, ...node } };
}

describe("admit", () => {
  it("admits a tailnet peer with the keeper as its human", () => {
    expect(admit(recordedHost.ipv4, recordedPeerWhois())).toEqual({
      admitted: true,
      caller: {
        address: recordedHost.ipv4,
        node: { stableId: recordedHost.stableId, name: "host", os: "linux", tags: [] },
        human: {
          userId: recordedKeeper.userId,
          loginName: recordedKeeper.loginName,
          displayName: recordedKeeper.displayName,
        },
        capMap: {},
      },
    });
  });

  it("denies an address tailscaled answered 404 for", () => {
    expect(admit("100.99.99.99", null)).toMatchObject({ admitted: false, reason: "not-a-peer" });
  });

  it("denies a node whose key expired", () => {
    expect(admit(recordedHost.ipv4, whoisWith({ expired: true }))).toMatchObject({
      admitted: false,
      reason: "expired",
    });
  });

  it("denies a node shared in from another tailnet", () => {
    expect(admit(recordedHost.ipv4, whoisWith({ sharerId: "4242" }))).toMatchObject({
      admitted: false,
      reason: "shared-in",
    });
  });

  it("admits a tagged node without a human identity", () => {
    const admission = admit(recordedHost.ipv4, whoisWith({ tags: ["tag:agent-host"] }));
    expect(admission).toMatchObject({
      admitted: true,
      caller: { human: null, node: { tags: ["tag:agent-host"] } },
    });
  });
});

describe("identifyCaller", () => {
  it("looks the caller up by its socket address", async () => {
    const asked: string[] = [];
    const tailnet = {
      whois: async (address: string) => {
        asked.push(address);
        return recordedPeerWhois();
      },
    };
    const admission = await identifyCaller(tailnet, `::ffff:${recordedHost.ipv4}`);
    expect(admission.admitted).toBe(true);
    expect(asked).toEqual([recordedHost.ipv4]);
  });

  it("fails closed when WhoIs itself fails", async () => {
    const tailnet = {
      whois: async () => {
        throw new Error("tailscaled went away");
      },
    };
    expect(await identifyCaller(tailnet, recordedHost.ipv4)).toEqual({
      admitted: false,
      address: recordedHost.ipv4,
      reason: "whois-failed",
      detail: "tailscaled went away",
    });
  });

  it("denies a connection with no remote address", async () => {
    const tailnet = { whois: async () => recordedPeerWhois() };
    expect(await identifyCaller(tailnet, undefined)).toMatchObject({ reason: "not-a-peer" });
  });
});
