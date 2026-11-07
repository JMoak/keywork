import { z } from "zod";
import { displayText, flag, optionalTimestamp, stringList } from "./fields.ts";
import { int64Id, parseTailscaleJson } from "./tailscale-json.ts";

export interface WhoIs {
  node: WhoIsNode;
  user: WhoIsUser;
  capMap: Readonly<Record<string, readonly unknown[]>>;
}

export interface WhoIsNode {
  stableId: string;
  name: string;
  computedName: string;
  os: string;
  userId: string;
  sharerId: string | null;
  addresses: string[];
  tags: string[];
  online: boolean | null;
  expired: boolean;
  keyExpiry: string | null;
}

export interface WhoIsUser {
  id: string;
  loginName: string;
  displayName: string;
}

export function parseWhoIs(text: string): WhoIs {
  return parseTailscaleJson(text, whoIsSchema, "tailscale whois");
}

export function isTaggedNode(whois: WhoIs): boolean {
  return whois.node.tags.length > 0;
}

export function isSharedIn(whois: WhoIs): boolean {
  return whois.node.sharerId !== null;
}

const sharer = int64Id
  .nullish()
  .transform((value) => (value === null || value === undefined || value === "0" ? null : value));

const nodeSchema = z
  .object({
    StableID: z.string().min(1),
    Name: displayText,
    ComputedName: displayText,
    Hostinfo: z.object({ OS: displayText }).nullish().catch(null),
    User: int64Id,
    Sharer: sharer,
    Addresses: stringList,
    Tags: stringList,
    Online: z.boolean().nullish().catch(null),
    Expired: flag,
    KeyExpiry: optionalTimestamp,
  })
  .transform(
    (raw): WhoIsNode => ({
      stableId: raw.StableID,
      name: raw.Name,
      computedName: raw.ComputedName,
      os: raw.Hostinfo?.OS ?? "",
      userId: raw.User,
      sharerId: raw.Sharer,
      addresses: raw.Addresses.map(withoutPrefixLength),
      tags: raw.Tags,
      online: raw.Online ?? null,
      expired: raw.Expired,
      keyExpiry: raw.KeyExpiry,
    }),
  );

const userSchema = z
  .object({ ID: int64Id, LoginName: displayText, DisplayName: displayText })
  .transform(
    (raw): WhoIsUser => ({ id: raw.ID, loginName: raw.LoginName, displayName: raw.DisplayName }),
  );

const whoIsSchema = z
  .object({
    Node: nodeSchema,
    UserProfile: userSchema,
    CapMap: z.record(z.string(), z.array(z.unknown()).nullable()).nullish(),
  })
  .transform(
    (raw): WhoIs => ({
      node: raw.Node,
      user: raw.UserProfile,
      capMap: Object.fromEntries(
        Object.entries(raw.CapMap ?? {}).map(([capability, values]) => [capability, values ?? []]),
      ),
    }),
  );

function withoutPrefixLength(cidr: string): string {
  const slash = cidr.indexOf("/");
  return slash === -1 ? cidr : cidr.slice(0, slash);
}
