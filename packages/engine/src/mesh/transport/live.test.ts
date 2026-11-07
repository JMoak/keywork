import { describe, expect, it } from "vitest";
import { defaultTransport } from "./select.ts";
import { isRunning } from "./status.ts";
import { createTailnet } from "./tailnet.ts";
import { isTailnetAddress } from "./tailnet-address.ts";

const liveTailnet = process.env.KEYWORK_LIVE_TAILNET === "1";

describe.runIf(liveTailnet)("live: this machine's tailscaled", () => {
  const tailnet = createTailnet(defaultTransport(), { whoisMaxAgeMs: 1 });

  it("reads a running status with tailnet addresses and a self node", async () => {
    const status = await tailnet.status();
    expect(isRunning(status)).toBe(true);
    expect(status.tailscaleIPs.length).toBeGreaterThan(0);
    expect(status.tailscaleIPs.every(isTailnetAddress)).toBe(true);
    expect(status.self?.stableId).toMatch(/CNTRL$/);
  });

  it("identifies every online peer by WhoIs with the stable id the status names", async () => {
    const status = await tailnet.status();
    const online = status.peers.filter((peer) => peer.online && peer.tailscaleIPs.length > 0);
    expect(online.length).toBeGreaterThan(0);
    for (const peer of online) {
      const [address = ""] = peer.tailscaleIPs;
      expect((await tailnet.whois(address))?.node.stableId).toBe(peer.stableId);
    }
  });

  it("answers null for a CGNAT address no node holds", async () => {
    await expect(tailnet.whois("100.127.254.253")).resolves.toBeNull();
  });

  it("reports Funnel off", async () => {
    expect((await tailnet.serve()).funnel).toEqual([]);
  });
});
