import { isIP, isIPv4, isIPv6 } from "node:net";

export const tailnetIPv4Range = "100.64.0.0/10";
export const tailnetIPv6Range = "fd7a:115c:a1e0::/48";
export const tailnetRanges = [tailnetIPv4Range, tailnetIPv6Range] as const;

export function isTailnetAddress(address: string): boolean {
  const host = unmapIPv4(address);
  if (isIPv4(host)) return inTailnetIPv4Range(host);
  if (isIPv6(host)) return inTailnetIPv6Range(host);
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const host = unmapIPv4(address);
  if (isIPv4(host)) return host.startsWith("127.");
  if (isIPv6(host)) return isIPv6Loopback(host);
  return host === "localhost";
}

export function isWildcardAddress(address: string): boolean {
  const host = unmapIPv4(address);
  if (isIPv4(host)) return host === "0.0.0.0";
  if (isIPv6(host)) return ipv6Hextets(host).every((hextet) => hextet === 0);
  return false;
}

export function peerHost(address: string): string {
  return unmapIPv4(withoutZone(withoutPort(address.trim())));
}

export function isIPAddress(address: string): boolean {
  return isIP(address) !== 0;
}

export function urlHost(address: string): string {
  return isIPv6(address) ? `[${address}]` : address;
}

function withoutPort(address: string): string {
  if (address.startsWith("[")) {
    const closing = address.indexOf("]");
    return closing === -1 ? address : address.slice(1, closing);
  }
  if (isIP(address) !== 0) return address;
  const colon = address.lastIndexOf(":");
  const host = colon === -1 ? address : address.slice(0, colon);
  return isIPv4(host) ? host : address;
}

function withoutZone(address: string): string {
  const percent = address.indexOf("%");
  return percent === -1 ? address : address.slice(0, percent);
}

function unmapIPv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

function isIPv6Loopback(address: string): boolean {
  return ipv6Hextets(address).every((hextet, index) => hextet === (index < 7 ? 0 : 1));
}

function inTailnetIPv4Range(address: string): boolean {
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && (second & 0xc0) === 64;
}

function inTailnetIPv6Range(address: string): boolean {
  const [first, second, third] = ipv6Hextets(address);
  return first === 0xfd7a && second === 0x115c && third === 0xa1e0;
}

function ipv6Hextets(address: string): number[] {
  const [head = "", tail] = address.split("::");
  const headGroups = groupsOf(head);
  const tailGroups = tail === undefined ? [] : groupsOf(tail);
  const zeros = new Array<number>(8 - headGroups.length - tailGroups.length).fill(0);
  return tail === undefined ? headGroups : [...headGroups, ...zeros, ...tailGroups];
}

function groupsOf(part: string): number[] {
  if (part === "") return [];
  return part.split(":").flatMap((group) => {
    if (!isIPv4(group)) return [Number.parseInt(group, 16)];
    const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
}
