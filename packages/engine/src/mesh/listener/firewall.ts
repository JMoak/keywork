import { isTailnetAddress, tailnetRanges } from "../transport/tailnet-address.ts";
import { defaultMeshPort, isPort, type PortRange, screenUdpPorts } from "./ports.ts";

export interface FirewallRuleOptions {
  program: string;
  localAddresses: readonly string[];
  tcpPort?: number | undefined;
  udpPorts?: PortRange | null | undefined;
  ruleName?: string | undefined;
}

export const defaultFirewallRuleName = "stead mesh";

export function windowsFirewallScript(options: FirewallRuleOptions): string {
  const ruleName = options.ruleName ?? defaultFirewallRuleName;
  const tcpPort = options.tcpPort ?? defaultMeshPort;
  const udpPorts = options.udpPorts === undefined ? screenUdpPorts : options.udpPorts;
  assertScriptInputs(options.localAddresses, tcpPort, udpPorts);
  const scope = {
    program: options.program,
    localAddresses: options.localAddresses,
    group: ruleName,
  };
  const rules = [
    ruleFor({ ...scope, name: `${ruleName} (TCP)`, protocol: "TCP", ports: String(tcpPort) }),
    ...(udpPorts === null
      ? []
      : [
          ruleFor({
            ...scope,
            name: `${ruleName} (UDP)`,
            protocol: "UDP",
            ports: `${udpPorts.first}-${udpPorts.last}`,
          }),
        ]),
  ];
  return [
    "#Requires -RunAsAdministrator",
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -Group ${quoted(ruleName)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    ...rules,
    "",
  ].join("\n");
}

interface RuleSpec {
  name: string;
  group: string;
  program: string;
  protocol: "TCP" | "UDP";
  ports: string;
  localAddresses: readonly string[];
}

function ruleFor(rule: RuleSpec): string {
  return [
    "New-NetFirewallRule",
    `-DisplayName ${quoted(rule.name)}`,
    `-Group ${quoted(rule.group)}`,
    "-Direction Inbound",
    "-Action Allow",
    `-Program ${quoted(rule.program)}`,
    `-Protocol ${rule.protocol}`,
    `-LocalPort ${rule.ports}`,
    `-LocalAddress ${rule.localAddresses.map(quoted).join(",")}`,
    `-RemoteAddress ${tailnetRanges.map(quoted).join(",")}`,
    "-Profile Any",
    "| Out-Null",
  ].join(" ");
}

function assertScriptInputs(
  localAddresses: readonly string[],
  tcpPort: number,
  udpPorts: PortRange | null,
): void {
  if (localAddresses.length === 0) throw new Error("the rule needs this node's tailnet addresses");
  const stray = localAddresses.filter((address) => !isTailnetAddress(address));
  if (stray.length > 0) throw new Error(`not tailnet addresses: ${stray.join(", ")}`);
  if (!isPort(tcpPort)) throw new Error(`not a port: ${tcpPort}`);
  if (udpPorts !== null && !(isPort(udpPorts.first) && isPort(udpPorts.last))) {
    throw new Error(`not a port range: ${udpPorts.first}-${udpPorts.last}`);
  }
  if (udpPorts !== null && udpPorts.first > udpPorts.last) {
    throw new Error(`the port range runs backwards: ${udpPorts.first}-${udpPorts.last}`);
  }
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
