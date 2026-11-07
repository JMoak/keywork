import {
  canonicalJson,
  hmacBase64url,
  type MeshCaller,
  type PairRecord,
  sameSecret,
} from "@keywork/engine";

export const screenTicketTtlMs = 12 * 60 * 60_000;

export interface ScreenTicketKeys {
  readonly house: string;
  self(): string;
  pairs(): readonly PairRecord[];
  pairSecret(pairId: string): Promise<Uint8Array | undefined>;
  now?: (() => number) | undefined;
}

export type TicketHolder = { holder: "house" } | { holder: "pair"; pair: PairRecord };

export type TicketCheck =
  | ({ ok: true } & TicketHolder)
  | { ok: false; status: 401 | 403; problem: string };

export interface IssuedTicket {
  token: string;
  expiresAt: string;
}

export interface ScreenTickets {
  check(token: string | undefined, caller: MeshCaller, sessionId?: string): Promise<TicketCheck>;
  issue(pairId: string, sessionId: string): Promise<IssuedTicket | undefined>;
}

export function screenTickets(keys: ScreenTicketKeys): ScreenTickets {
  const now = keys.now ?? Date.now;
  return {
    check: async (token, caller, sessionId) => {
      if (token === undefined || token === "") return refused(401, missingTicket);
      const ticket = pairTicketOf(token);
      if (ticket !== undefined) return checkPair(keys, ticket, caller, sessionId, now());
      if (caller.node.stableId !== keys.self()) return refused(401, notATicket);
      if (!sameSecret(keys.house, token))
        return refused(401, "the house ticket is wrong: read it again from the node's state");
      return { ok: true, holder: "house" };
    },
    issue: async (pairId, sessionId) => {
      const secret = await keys.pairSecret(pairId);
      const paired = keys.pairs().some(({ id }) => id === pairId);
      if (secret === undefined || !paired) return undefined;
      const expires = now() + screenTicketTtlMs;
      const mac = ticketMac(secret, { pairId, sessionId, expires });
      return {
        token: `${pairPrefix}${pairId}.${expires}.${mac}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
  };
}

const pairPrefix = "pair.";

const missingTicket =
  "a screen ticket is required: send this house's ticket or a pair ticket as the bearer token";
const notATicket = "the bearer token is not a screen ticket: ask the console's own node for one";

interface PairTicket {
  pairId: string;
  expires: number;
  mac: string;
}

async function checkPair(
  keys: ScreenTicketKeys,
  ticket: PairTicket,
  caller: MeshCaller,
  sessionId: string | undefined,
  at: number,
): Promise<TicketCheck> {
  const pair = keys.pairs().find(({ id }) => id === ticket.pairId);
  if (pair === undefined) return refused(403, `this machine holds no pair ${ticket.pairId}`);
  if (!pairedWith(pair, caller))
    return refused(403, `pair ${pair.id} belongs to another machine, not ${caller.node.name}`);
  if (at > ticket.expires) return refused(401, "the pair ticket has expired: ask for a new one");
  if (sessionId === undefined) return refused(403, "a pair ticket opens one viewing session only");
  const secret = await keys.pairSecret(pair.id);
  const { pairId, expires } = ticket;
  const expected = secret === undefined ? "" : ticketMac(secret, { pairId, sessionId, expires });
  if (!sameSecret(expected, ticket.mac))
    return refused(401, `the pair ticket does not prove pair ${pair.id} for session ${sessionId}`);
  return { ok: true, holder: "pair", pair };
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
  fields: { pairId: string; sessionId: string; expires: number },
): string {
  return hmacBase64url(secret, canonicalJson({ purpose: "screen.signal", ...fields }));
}

function refused(status: 401 | 403, problem: string): TicketCheck {
  return { ok: false, status, problem };
}
