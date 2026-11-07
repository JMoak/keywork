import type { PortRange } from "../listener/ports.ts";

export type Protocol = "tcp" | "udp";

export interface PortSpec extends PortRange {
  protocol: Protocol | "any" | "other";
}

const everyPort: PortRange = { first: 1, last: 65535 };

export function parsePortList(entries: readonly string[]): PortSpec[] {
  return entries.flatMap(parsePortEntry);
}

export function protocolOf(proto: string | number | undefined): PortSpec["protocol"] {
  if (proto === undefined || proto === "*") return "any";
  const word = String(proto).toLowerCase();
  if (word === "tcp" || word === "6") return "tcp";
  if (word === "udp" || word === "17") return "udp";
  return "other";
}

export function missingPorts(wanted: PortRange, covered: readonly PortRange[]): PortRange[] {
  let missing: PortRange[] = [wanted];
  for (const range of covered) missing = missing.flatMap((gap) => without(gap, range));
  return missing;
}

export function overlaps(left: PortRange, right: PortRange): boolean {
  return left.first <= right.last && right.first <= left.last;
}

export function portWords(range: PortRange): string {
  return range.first === range.last ? `${range.first}` : `${range.first}-${range.last}`;
}

function parsePortEntry(entry: string): PortSpec[] {
  const trimmed = entry.trim();
  if (trimmed === "*") return [{ protocol: "any", ...everyPort }];
  const colon = trimmed.indexOf(":");
  const protocol = colon === -1 ? "any" : protocolOf(trimmed.slice(0, colon));
  const ports = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  return ports
    .split(",")
    .map(parseRange)
    .filter((range): range is PortRange => range !== null)
    .map((range) => ({ protocol, ...range }));
}

function parseRange(text: string): PortRange | null {
  const trimmed = text.trim();
  if (trimmed === "*") return everyPort;
  const bounds = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (bounds === null) return null;
  const first = Number(bounds[1]);
  const last = Number(bounds[2] ?? bounds[1]);
  return isPortNumber(first) && isPortNumber(last) && first <= last ? { first, last } : null;
}

function isPortNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

function without(gap: PortRange, taken: PortRange): PortRange[] {
  if (!overlaps(gap, taken)) return [gap];
  const left = taken.first > gap.first ? [{ first: gap.first, last: taken.first - 1 }] : [];
  const right = taken.last < gap.last ? [{ first: taken.last + 1, last: gap.last }] : [];
  return [...left, ...right];
}
