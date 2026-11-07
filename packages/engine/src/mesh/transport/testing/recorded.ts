import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type RecordedFixture =
  | "status-running"
  | "status-direct"
  | "whois-peer"
  | "whois-peer-v6"
  | "whois-self";

export const fixturesDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

export const recordedHouse = {
  stableId: "nHouseA1b2CNTRL",
  ipv4: "100.101.102.103",
  ipv6: "fd7a:115c:a1e0::6566:6767",
} as const;

export const recordedHost = {
  stableId: "nHostC3d4CNTRL",
  ipv4: "100.88.77.66",
  ipv6: "fd7a:115c:a1e0::5841:4d42",
} as const;

export const recordedKeeper = {
  userId: "7000000000000001",
  loginName: "keeper@example.com",
  displayName: "Keeper",
} as const;

export function recordedText(fixture: RecordedFixture): string {
  return readFileSync(new URL(`../fixtures/${fixture}.json`, import.meta.url), "utf8");
}

export function recordedJson(fixture: RecordedFixture): Record<string, unknown> {
  return JSON.parse(recordedText(fixture)) as Record<string, unknown>;
}

export function editedJson(
  fixture: RecordedFixture,
  edit: (json: Record<string, Record<string, unknown>>) => void,
): string {
  const json = recordedJson(fixture) as Record<string, Record<string, unknown>>;
  edit(json);
  return JSON.stringify(json);
}
