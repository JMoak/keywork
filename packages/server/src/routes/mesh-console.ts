import type { BegunPairing, PairingConfirmation, PairRole } from "@keywork/engine";
import type { RouteSpec } from "./family.ts";

export type OutboundPhase = "comparing" | "confirming";

export interface OutboundPairing {
  attemptId: string;
  peerStableId: string;
  peerUserId: string | null;
  endpoint: string;
  role: PairRole;
  caps: string[];
  sas: string;
  confirmation: PairingConfirmation;
  phase: OutboundPhase;
  startedAt: string;
  expiresAt: string;
}

export interface OutboundTarget {
  endpoint: string;
  stableId: string;
  userId: string | null;
  role: PairRole;
  caps: string[];
}

export interface OutboundPairings {
  began(target: OutboundTarget, begun: BegunPairing): void;
  confirming(attemptId: string): void;
  ended(attemptId: string): void;
  live(): OutboundPairing[];
}

export const meshConsoleRoutes = [
  {
    method: "GET",
    path: "/mesh/peers",
    operationId: "listMeshPeers",
    summary:
      "The tailnet as this console sees it: `{ self, peers }`, each a machine `{ stableId, machine, dnsName, os, addresses, tags, user, online, active, candidate, path, node, manifest, endpoint? }`. Identity comes from `tailscale status` (`user` is null for a tagged machine); `path` is the lane (`direct`, `peer-relay`, `derp`, `offline`, `unknown`); `node` is the machine's unauthenticated `GET /mesh/hello` (`{ product, version, pairing }`), null when no keywork node answers or the peer is offline, shared in or expired; `endpoint` is the node's mesh base URL, the pair's when paired, else the address that answered. `manifest` is `{ roles }` from the node's manifest, which a node serves only to the consoles it is paired with, so it is null for every unpaired peer. `self` is this machine, with the manifest this node publishes.",
    authenticated: true,
    responses: {
      "200": "`{ self, peers }`.",
      "502": "Tailscale did not answer; `error` says why.",
      "503": "This node takes no tailnet census.",
    },
  },
  {
    method: "GET",
    path: "/mesh/pairings",
    operationId: "listMeshPairings",
    summary:
      "The pairing attempts this console began with `POST /mesh/pairs` and has not finished: `{ pairings }`, each `{ attemptId, peerStableId, peerUserId, endpoint, role, caps, sas, confirmation, phase, startedAt, expiresAt }`. `sas` is the six-digit code to compare with the one the node shows; `confirmation` is what the node needs (`on-device`, `claim-code` or `endorsement`); `phase` is `comparing` until `POST /mesh/pairs/{id}/complete` is called, then `confirming` while the node's keeper confirms. An attempt leaves the list when it completes, is cancelled or expires; attempts live in this console's memory and end with it.",
    authenticated: true,
    responses: { "200": "`{ pairings }`.", "503": "The mesh is not served." },
  },
] as const satisfies readonly RouteSpec[];

export function outboundPairings(now: () => number): OutboundPairings {
  const attempts = new Map<string, OutboundPairing>();
  return {
    began: (target, begun) => {
      attempts.set(begun.attemptId, {
        attemptId: begun.attemptId,
        peerStableId: target.stableId,
        peerUserId: target.userId,
        endpoint: target.endpoint,
        role: target.role,
        caps: target.caps,
        sas: begun.sas,
        confirmation: begun.confirmation,
        phase: "comparing",
        startedAt: new Date(now()).toISOString(),
        expiresAt: begun.expiresAt,
      });
    },
    confirming: (attemptId) => {
      const held = attempts.get(attemptId);
      if (held !== undefined) attempts.set(attemptId, { ...held, phase: "confirming" });
    },
    ended: (attemptId) => {
      attempts.delete(attemptId);
    },
    live: () => {
      for (const [attemptId, attempt] of attempts) {
        if (Date.parse(attempt.expiresAt) <= now()) attempts.delete(attemptId);
      }
      return [...attempts.values()];
    },
  };
}
