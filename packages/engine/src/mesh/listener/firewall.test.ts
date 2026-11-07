import { describe, expect, it } from "vitest";
import { recordedHouse } from "../transport/testing/recorded.ts";
import { windowsFirewallScript } from "./firewall.ts";

const program = "C:\\Users\\keeper\\AppData\\Local\\keywork\\bin\\keywork.exe";
const localAddresses = [recordedHouse.ipv4, recordedHouse.ipv6];

describe("windowsFirewallScript", () => {
  const script = windowsFirewallScript({ program, localAddresses });
  const lines = script.split("\n");

  it("replaces the product's rules rather than piling up duplicates", () => {
    expect(lines.slice(0, 3)).toEqual([
      "#Requires -RunAsAdministrator",
      "$ErrorActionPreference = 'Stop'",
      "Get-NetFirewallRule -Group 'stead mesh' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    ]);
  });

  it("allows the TCP port to this program from tailnet ranges to tailnet addresses only", () => {
    const tcp = lines.find((line) => line.includes("-Protocol TCP"));
    expect(tcp).toBe(
      [
        "New-NetFirewallRule",
        "-DisplayName 'stead mesh (TCP)'",
        "-Group 'stead mesh'",
        "-Direction Inbound",
        "-Action Allow",
        `-Program '${program}'`,
        "-Protocol TCP",
        "-LocalPort 47800",
        `-LocalAddress '${recordedHouse.ipv4}','${recordedHouse.ipv6}'`,
        "-RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48'",
        "-Profile Any",
        "| Out-Null",
      ].join(" "),
    );
  });

  it("adds the WebRTC UDP range with the same scope", () => {
    const udp = lines.find((line) => line.includes("-Protocol UDP"));
    expect(udp).toContain("-LocalPort 47810-47829");
    expect(udp).toContain("-RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48'");
  });

  it("can leave the UDP rule out and use other ports", () => {
    const tcpOnly = windowsFirewallScript({
      program,
      localAddresses,
      tcpPort: 4900,
      udpPorts: null,
    });
    expect(tcpOnly).toContain("-LocalPort 4900");
    expect(tcpOnly).not.toContain("UDP");
  });

  it("quotes a program path with an apostrophe", () => {
    const quirky = windowsFirewallScript({ program: "C:\\O'Brien\\keywork.exe", localAddresses });
    expect(quirky).toContain("-Program 'C:\\O''Brien\\keywork.exe'");
  });

  it("refuses to scope a rule to anything but tailnet addresses and real ports", () => {
    expect(() => windowsFirewallScript({ program, localAddresses: [] })).toThrow(
      /tailnet addresses/,
    );
    expect(() => windowsFirewallScript({ program, localAddresses: ["0.0.0.0"] })).toThrow(
      /0.0.0.0/,
    );
    expect(() => windowsFirewallScript({ program, localAddresses, tcpPort: 70000 })).toThrow(
      /port/,
    );
    expect(() =>
      windowsFirewallScript({ program, localAddresses, udpPorts: { first: 9, last: 2 } }),
    ).toThrow(/backwards/);
  });
});
