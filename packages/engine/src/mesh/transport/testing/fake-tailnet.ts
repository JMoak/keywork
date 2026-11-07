import { type PingResult, pingFailure } from "../ping.ts";
import type { ServePosture } from "../serve-config.ts";
import { parseStatus, type TailnetStatus } from "../status.ts";
import type { Tailnet } from "../tailnet.ts";
import { peerHost } from "../tailnet-address.ts";
import { parseWhoIs, type WhoIs } from "../whois.ts";
import { recordedText } from "./recorded.ts";

export interface FakeTailnet extends Tailnet {
  current: {
    status: TailnetStatus;
    posture: ServePosture;
    identities: Map<string, WhoIs>;
    failStatus: boolean;
  };
  whoisCalls: string[];
}

export function fakeTailnet(): FakeTailnet {
  const current = {
    status: parseStatus(recordedText("status-running")),
    posture: { serving: false, funnel: [] } as ServePosture,
    identities: new Map<string, WhoIs>(),
    failStatus: false,
  };
  const whoisCalls: string[] = [];
  return {
    transport: "fake",
    current,
    whoisCalls,
    status: async () => {
      if (current.failStatus) throw new Error("tailscaled is not answering");
      return current.status;
    },
    whois: async (address) => {
      const host = peerHost(address);
      whoisCalls.push(host);
      return current.identities.get(host) ?? null;
    },
    ping: async (): Promise<PingResult> => pingFailure("the fake does not ping"),
    serve: async () => current.posture,
    forgetIdentities: () => undefined,
  };
}

export function recordedPeerWhois(): WhoIs {
  return parseWhoIs(recordedText("whois-peer"));
}

export function withStatus(status: TailnetStatus, change: Partial<TailnetStatus>): TailnetStatus {
  return { ...status, ...change };
}
