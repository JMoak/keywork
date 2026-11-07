import type { MeshCaller } from "../mesh/listener/admission.ts";
import { canonicalJson, hmacBase64url, sameSecret } from "../mesh/pairing/canonical.ts";
import type { PairRecord } from "../mesh/pairing/store.ts";

export const creatureTicketTtlMs = 12 * 60 * 60_000;

export interface CreatureTicketKeys {
  readonly house: string;
  self(): string;
  pairs(): readonly PairRecord[];
  pairSecret(pairId: string): Promise<Uint8Array | undefined>;
  now?: (() => number) | undefined;
}

export type CreatureTicketCheck =
  | { ok: true; pair: PairRecord }
  | { ok: false; status: 401 | 403; problem: string };

export interface IssuedCreatureTicket {
  token: string;
  pairId: string;
  creature: string;
  expiresAt: string;
}

export type CreatureTicketIssue =
  | IssuedCreatureTicket
  | { refused: true; status: 401 | 403 | 404; problem: string };

export interface CreatureTickets {
  check(
    token: string | undefined,
    caller: MeshCaller,
    creature: string,
  ): Promise<CreatureTicketCheck>;
  issue(
    house: string | undefined,
    caller: MeshCaller,
    target: { node: string; creature: string },
  ): Promise<CreatureTicketIssue>;
}

export function creatureTickets(keys: CreatureTicketKeys): CreatureTickets {
  const now = keys.now ?? Date.now;
  return {
    check: async (token, caller, creature) => {
      if (token === undefined || token === "") return refused(401, missingTicket);
      const ticket = pairTicketOf(token);
      if (ticket === undefined) return refused(401, notATicket);
      return checkPair(keys, ticket, caller, creature, now());
    },
    issue: async (house, caller, { node, creature }) => {
      if (caller.node.stableId !== keys.self() || house === undefined)
        return issueRefused(401, "only this machine's own agents may ask its node for a ticket");
      if (!sameSecret(keys.house, house))
        return issueRefused(401, "the house ticket is wrong: read it again from the node's state");
      const pair = keys.pairs().find(({ peerStableId }) => peerStableId === node);
      if (pair === undefined)
        return issueRefused(404, `this machine is not paired with ${node}: pair them first`);
      const secret = await keys.pairSecret(pair.id);
      if (secret === undefined)
        return issueRefused(403, `this machine holds no secret for pair ${pair.id}`);
      const expires = now() + creatureTicketTtlMs;
      const mac = ticketMac(secret, { pairId: pair.id, creature, expires });
      return {
        token: `${pairPrefix}${pair.id}.${expires}.${mac}`,
        pairId: pair.id,
        creature,
        expiresAt: new Date(expires).toISOString(),
      };
    },
  };
}

const pairPrefix = "pair.";
const missingTicket =
  "a creature ticket is required: ask your own node for one and send it as the bearer token";
const notATicket = "the bearer token is not a creature ticket: ask your own node for one";

interface PairTicket {
  pairId: string;
  expires: number;
  mac: string;
}

async function checkPair(
  keys: CreatureTicketKeys,
  ticket: PairTicket,
  caller: MeshCaller,
  creature: string,
  at: number,
): Promise<CreatureTicketCheck> {
  const pair = keys.pairs().find(({ id }) => id === ticket.pairId);
  if (pair === undefined) return refused(403, `this machine holds no pair ${ticket.pairId}`);
  if (!pairedWith(pair, caller))
    return refused(403, `pair ${pair.id} belongs to another machine, not ${caller.node.name}`);
  if (at > ticket.expires)
    return refused(401, "the creature ticket has expired: ask for a new one");
  const secret = await keys.pairSecret(pair.id);
  const { pairId, expires } = ticket;
  const expected = secret === undefined ? "" : ticketMac(secret, { pairId, creature, expires });
  if (!sameSecret(expected, ticket.mac))
    return refused(401, `the ticket does not prove pair ${pair.id} for ${creature}`);
  return { ok: true, pair };
}

function pairTicketOf(token: string): PairTicket | undefined {
  if (!token.startsWith(pairPrefix)) return undefined;
  const fields = token.slice(pairPrefix.length).split(".");
  const mac = fields.pop();
  const expires = Number(fields.pop());
  const pairId = fields.join(".");
  if (mac === undefined || pairId === "" || !Number.isSafeInteger(expires)) return undefined;
  return { pairId, expires, mac };
}

function pairedWith(pair: PairRecord, caller: MeshCaller): boolean {
  return (
    pair.peerStableId === caller.node.stableId && pair.peerUserId === (caller.human?.userId ?? null)
  );
}

function ticketMac(
  secret: Uint8Array,
  fields: { pairId: string; creature: string; expires: number },
): string {
  return hmacBase64url(secret, canonicalJson({ purpose: "creature.mcp", ...fields }));
}

function refused(status: 401 | 403, problem: string): CreatureTicketCheck {
  return { ok: false, status, problem };
}

function issueRefused(status: 401 | 403 | 404, problem: string): CreatureTicketIssue {
  return { refused: true, status, problem };
}
