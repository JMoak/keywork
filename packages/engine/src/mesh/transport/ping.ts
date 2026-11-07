import { z } from "zod";
import { displayText } from "./fields.ts";
import { parseTailscaleJson } from "./tailscale-json.ts";

export type PingResult = PingReply | PingFailure;

export interface PingReply {
  ok: true;
  nodeName: string;
  nodeIP: string;
  latencyMs: number;
  endpoint: string;
  peerRelay: string;
  derpRegion: string;
}

export interface PingFailure {
  ok: false;
  error: string;
}

export function parsePingJson(text: string): PingResult {
  return parseTailscaleJson(text, pingSchema, "tailscale ping");
}

export function parsePingOutput(output: string): PingResult {
  const replies = output.split(/\r?\n/).map(parsePongLine);
  const reply = replies.findLast((parsed): parsed is PingReply => parsed !== null);
  return reply ?? { ok: false, error: output.trim() || "no reply" };
}

export function pingFailure(error: string): PingFailure {
  return { ok: false, error };
}

const pongLine = /^pong from (\S+) \(([^)]*)\) via (.+) in (\S+)$/;

function parsePongLine(line: string): PingReply | null {
  const match = pongLine.exec(line.trim());
  if (match === null) return null;
  const [, nodeName = "", nodeIP = "", via = "", latency = ""] = match;
  const latencyMs = goDurationMs(latency);
  if (latencyMs === null) return null;
  return { ok: true, nodeName, nodeIP: hostWithoutPort(nodeIP), latencyMs, ...routeOf(via) };
}

function routeOf(via: string): Pick<PingReply, "endpoint" | "peerRelay" | "derpRegion"> {
  const derp = /^DERP\((.*)\)$/.exec(via);
  if (derp !== null) return { endpoint: "", peerRelay: "", derpRegion: derp[1] ?? "" };
  const relay = /^peer-relay\((.*)\)$/.exec(via);
  if (relay !== null) return { endpoint: "", peerRelay: relay[1] ?? "", derpRegion: "" };
  return { endpoint: via, peerRelay: "", derpRegion: "" };
}

const durationUnitsMs: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function goDurationMs(duration: string): number | null {
  const parts = [...duration.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
  if (parts.map((part) => part[0]).join("") !== duration || parts.length === 0) return null;
  return parts.reduce(
    (total, [, amount = "0", unit = "ms"]) => total + Number(amount) * (durationUnitsMs[unit] ?? 0),
    0,
  );
}

function hostWithoutPort(nodeIP: string): string {
  const colon = nodeIP.lastIndexOf(":");
  return colon !== -1 && nodeIP.indexOf(":") === colon ? nodeIP.slice(0, colon) : nodeIP;
}

const pingSchema = z
  .object({
    NodeName: displayText,
    NodeIP: displayText,
    Err: displayText,
    LatencySeconds: z.number().catch(0),
    Endpoint: displayText,
    PeerRelay: displayText,
    DERPRegionCode: displayText,
  })
  .transform(
    (raw): PingResult =>
      raw.Err !== ""
        ? { ok: false, error: raw.Err }
        : {
            ok: true,
            nodeName: raw.NodeName,
            nodeIP: raw.NodeIP,
            latencyMs: raw.LatencySeconds * 1_000,
            endpoint: raw.Endpoint,
            peerRelay: raw.PeerRelay,
            derpRegion: raw.DERPRegionCode,
          },
  );
