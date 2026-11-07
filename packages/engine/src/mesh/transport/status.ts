import { z } from "zod";
import { displayText, flag, optionalTimestamp, stringList } from "./fields.ts";
import { int64Id, parseTailscaleJson } from "./tailscale-json.ts";

export const backendStates = [
  "NoState",
  "NeedsLogin",
  "NeedsMachineAuth",
  "Stopped",
  "Starting",
  "Running",
] as const;

export type BackendState = (typeof backendStates)[number];

export interface TailnetStatus {
  version: string;
  tun: boolean;
  backendState: BackendState | "Unknown";
  tailscaleIPs: string[];
  tailnet: TailnetInfo | null;
  self: TailnetNode | null;
  peers: TailnetNode[];
  users: Readonly<Record<string, TailnetUser>>;
  health: string[];
}

export interface TailnetInfo {
  name: string;
  stableId: string;
  magicDNSSuffix: string;
}

export interface TailnetNode {
  stableId: string;
  publicKey: string;
  hostName: string;
  dnsName: string;
  os: string;
  userId: string;
  tailscaleIPs: string[];
  tags: string[];
  curAddr: string;
  relay: string;
  peerRelay: string;
  online: boolean;
  active: boolean;
  expired: boolean;
  keyExpiry: string | null;
  sharee: boolean;
  inNetworkMap: boolean;
}

export interface TailnetUser {
  id: string;
  loginName: string;
  displayName: string;
}

export function parseStatus(text: string): TailnetStatus {
  return parseTailscaleJson(text, statusSchema, "tailscale status");
}

export function isRunning(status: TailnetStatus): boolean {
  return status.backendState === "Running";
}

export function userOf(status: TailnetStatus, node: TailnetNode): TailnetUser | null {
  return status.users[node.userId] ?? null;
}

export function statusFingerprint(status: TailnetStatus): string {
  const nodes = [status.self, ...status.peers]
    .filter((node): node is TailnetNode => node !== null)
    .map(identityOf)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([status.backendState, status.tailscaleIPs, nodes]);
}

function identityOf(node: TailnetNode): [string, ...unknown[]] {
  return [
    node.stableId,
    node.publicKey,
    node.userId,
    node.tailscaleIPs,
    node.tags,
    node.expired,
    node.keyExpiry,
    node.sharee,
    node.inNetworkMap,
  ];
}

const nodeSchema = z
  .object({
    ID: z.string().min(1),
    PublicKey: displayText,
    HostName: displayText,
    DNSName: displayText,
    OS: displayText,
    UserID: int64Id,
    TailscaleIPs: stringList,
    Tags: stringList,
    CurAddr: displayText,
    Relay: displayText,
    PeerRelay: displayText,
    Online: flag.catch(false),
    Active: flag.catch(false),
    KeyExpiry: optionalTimestamp,
    Expired: flag,
    ShareeNode: flag,
    InNetworkMap: flag,
  })
  .transform(
    (raw): TailnetNode => ({
      stableId: raw.ID,
      publicKey: raw.PublicKey,
      hostName: raw.HostName,
      dnsName: raw.DNSName,
      os: raw.OS,
      userId: raw.UserID,
      tailscaleIPs: raw.TailscaleIPs,
      tags: raw.Tags,
      curAddr: raw.CurAddr,
      relay: raw.Relay,
      peerRelay: raw.PeerRelay,
      online: raw.Online,
      active: raw.Active,
      expired: raw.Expired,
      keyExpiry: raw.KeyExpiry,
      sharee: raw.ShareeNode,
      inNetworkMap: raw.InNetworkMap,
    }),
  );

const userSchema = z
  .object({ ID: int64Id, LoginName: displayText, DisplayName: displayText })
  .transform(
    (raw): TailnetUser => ({
      id: raw.ID,
      loginName: raw.LoginName,
      displayName: raw.DisplayName,
    }),
  );

const tailnetSchema = z
  .object({ Name: displayText, StableID: displayText, MagicDNSSuffix: displayText })
  .transform(
    (raw): TailnetInfo => ({
      name: raw.Name,
      stableId: raw.StableID,
      magicDNSSuffix: raw.MagicDNSSuffix,
    }),
  );

const statusSchema = z
  .object({
    Version: displayText,
    TUN: z.boolean().catch(false),
    BackendState: z.enum([...backendStates, "Unknown"]).catch("Unknown"),
    TailscaleIPs: stringList,
    CurrentTailnet: tailnetSchema.nullish(),
    Self: nodeSchema.nullish(),
    Peer: z.record(z.string(), nodeSchema).nullish(),
    User: z.record(z.string(), userSchema).nullish(),
    Health: stringList.catch([]),
  })
  .transform(
    (raw): TailnetStatus => ({
      version: raw.Version,
      tun: raw.TUN,
      backendState: raw.BackendState,
      tailscaleIPs: raw.TailscaleIPs,
      tailnet: raw.CurrentTailnet ?? null,
      self: raw.Self ?? null,
      peers: Object.values(raw.Peer ?? {}),
      users: raw.User ?? {},
      health: raw.Health,
    }),
  );
