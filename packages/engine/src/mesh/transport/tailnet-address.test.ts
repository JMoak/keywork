import { describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  isTailnetAddress,
  isWildcardAddress,
  peerHost,
  urlHost,
} from "./tailnet-address.ts";

describe("isTailnetAddress", () => {
  it.each([
    "100.64.0.0",
    "100.101.102.103",
    "100.127.255.255",
    "::ffff:100.88.77.66",
    "fd7a:115c:a1e0::1",
    "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff",
    "FD7A:115C:A1E0::6566:6767",
  ])("accepts %s inside 100.64.0.0/10 or fd7a:115c:a1e0::/48", (address) => {
    expect(isTailnetAddress(address)).toBe(true);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "10.0.0.1",
    "192.168.1.30",
    "127.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "fd7a:115c:a1e1::1",
    "fe80::1",
    "2001:db8::10",
    "host.tail5e7d00.ts.net",
    "",
  ])("refuses %s", (address) => {
    expect(isTailnetAddress(address)).toBe(false);
  });
});

describe("loopback and wildcard", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "localhost"])(
    "%s is loopback",
    (address) => expect(isLoopbackAddress(address)).toBe(true),
  );

  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"])("%s is a wildcard", (address) => {
    expect(isWildcardAddress(address)).toBe(true);
  });

  it("does not mistake a tailnet address for either", () => {
    expect(isLoopbackAddress("100.101.102.103")).toBe(false);
    expect(isWildcardAddress("fd7a:115c:a1e0::1")).toBe(false);
  });
});

describe("peerHost", () => {
  it.each([
    ["100.88.77.66", "100.88.77.66"],
    ["100.88.77.66:443", "100.88.77.66"],
    ["[fd7a:115c:a1e0::5841:4d42]:443", "fd7a:115c:a1e0::5841:4d42"],
    ["fd7a:115c:a1e0::5841:4d42", "fd7a:115c:a1e0::5841:4d42"],
    ["::ffff:100.88.77.66", "100.88.77.66"],
    ["fe80::1%eth0", "fe80::1"],
    [" 100.88.77.66 ", "100.88.77.66"],
  ])("reads %s as %s", (address, host) => {
    expect(peerHost(address)).toBe(host);
  });

  it("brackets IPv6 hosts for URLs and leaves IPv4 alone", () => {
    expect(urlHost("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
    expect(urlHost("100.88.77.66")).toBe("100.88.77.66");
  });
});
