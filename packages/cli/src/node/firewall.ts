import { isTailnetAddress, localInterfaceAddresses, windowsFirewallScript } from "@keywork/engine";
import type { NodeConfig } from "./config.ts";

export type FirewallScript = { ok: true; script: string } | { ok: false; reason: string };

export function meshFirewallScript(options: {
  program: string;
  config: NodeConfig;
  addresses: readonly string[];
}): FirewallScript {
  const { config } = options;
  if (!config.mesh.enabled) {
    return { ok: false, reason: "the mesh listener is off in the node config" };
  }
  const localAddresses = options.addresses.filter(isTailnetAddress);
  if (localAddresses.length === 0) {
    return {
      ok: false,
      reason:
        "this machine has no tailnet address yet; start Tailscale, then run keywork node firewall",
    };
  }
  return {
    ok: true,
    script: windowsFirewallScript({
      program: options.program,
      localAddresses,
      tcpPort: config.mesh.port,
      udpPorts: config.mesh.screenUdp,
    }),
  };
}

export function interfaceAddresses(): string[] {
  return localInterfaceAddresses();
}
