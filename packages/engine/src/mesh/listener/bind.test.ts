import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseStatus, type TailnetStatus } from "../transport/status.ts";
import { recordedHouse, recordedText } from "../transport/testing/recorded.ts";
import {
  assertTailnetBindable,
  listenOnTailnet,
  localInterfaceAddresses,
  MeshBindRefusedError,
  planBinds,
} from "./bind.ts";

const running = parseStatus(recordedText("status-running"));
const bothTailnetAddresses = [recordedHouse.ipv4, recordedHouse.ipv6];
const interfaces = ["127.0.0.1", "::1", "192.168.1.20", ...bothTailnetAddresses];

function statusWith(change: Partial<TailnetStatus>): TailnetStatus {
  return { ...running, ...change };
}

describe("binds that are refused", () => {
  it.each([
    ["127.0.0.1", /loopback/],
    ["::1", /loopback/],
    ["0.0.0.0", /wildcard/],
    ["::", /wildcard/],
    ["192.168.1.20", /not a tailnet address/],
    ["10.0.0.1", /not a tailnet address/],
    ["fe80::1", /not a tailnet address/],
    ["203.0.113.10", /not a tailnet address/],
    ["localhost", /not an IP address/],
  ])("refuses %s", (address, why) => {
    expect(() => assertTailnetBindable(address)).toThrow(MeshBindRefusedError);
    expect(() => assertTailnetBindable(address)).toThrow(why);
  });

  it.each(bothTailnetAddresses)("allows the tailnet address %s", (address) => {
    expect(() => assertTailnetBindable(address)).not.toThrow();
  });

  it.each(["127.0.0.1", "0.0.0.0", "192.168.1.20"])(
    "never opens a socket on %s",
    async (address) => {
      const server = createServer();
      await expect(listenOnTailnet(server, address, 0)).rejects.toBeInstanceOf(
        MeshBindRefusedError,
      );
      expect(server.listening).toBe(false);
    },
  );
});

describe("planBinds", () => {
  it("binds one listener per tailnet address that is on a local interface, IPv4 and IPv6", () => {
    expect(planBinds(running, interfaces)).toEqual({ addresses: bothTailnetAddresses, idle: null });
  });

  it("skips a tailnet address no local interface carries", () => {
    expect(planBinds(running, ["127.0.0.1", recordedHouse.ipv4])).toEqual({
      addresses: [recordedHouse.ipv4],
      idle: null,
    });
    expect(planBinds(running, ["127.0.0.1"])).toEqual({
      addresses: [],
      idle: "no-local-tailnet-address",
    });
  });

  it("drops loopback and non-tailnet addresses even when the status lists them", () => {
    const odd = statusWith({ tailscaleIPs: ["127.0.0.1", "192.168.1.20", recordedHouse.ipv4] });
    expect(planBinds(odd, interfaces).addresses).toEqual([recordedHouse.ipv4]);
  });

  it.each(["Stopped", "Starting", "NeedsLogin", "NeedsMachineAuth", "NoState", "Unknown"] as const)(
    "binds nothing while the backend is %s",
    (backendState) => {
      expect(planBinds(statusWith({ backendState }), interfaces)).toEqual({
        addresses: [],
        idle: "not-running",
      });
    },
  );

  it("binds nothing in userspace networking, where no tailnet address is bindable", () => {
    expect(planBinds(statusWith({ tun: false }), interfaces)).toEqual({
      addresses: [],
      idle: "userspace-networking",
    });
  });

  it("reads this machine's interface addresses", () => {
    expect(localInterfaceAddresses()).toContain("127.0.0.1");
  });
});
