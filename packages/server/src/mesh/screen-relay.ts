import type { MeshCaller } from "@keywork/engine";
import { bodyOf, json } from "../routes/family.ts";
import type { MeshRoute } from "./router.ts";
import { meshScreenSignalPath } from "./routes.ts";
import { type PeerIdentity, type ScreenSignal, screenSignalSchema } from "./screen-signaling.ts";
import type { ScreenTickets, TicketCheck } from "./screen-tickets.ts";

export const meshScreenTicketPath = "/mesh/screen/tickets";
export const relayHeartbeatMs = 5_000;
export const relaySessionIdleMs = 2 * 60_000;
export const relayMailboxLimit = 256;

export interface ScreenRelayOptions {
  tickets: ScreenTickets;
  machine(): string;
  now?: (() => number) | undefined;
  heartbeatMs?: number | undefined;
}

export function screenSignalRelay(options: ScreenRelayOptions): MeshRoute[] {
  const relay = signalRelay(options);
  return [
    { method: "GET", path: meshScreenSignalPath, handle: relay.follow },
    { method: "POST", path: meshScreenSignalPath, handle: relay.deliver },
    { method: "POST", path: meshScreenTicketPath, handle: relay.issue },
  ];
}

type Handle = MeshRoute["handle"];

interface Mailbox {
  pending: string[];
  stream: EventStream | undefined;
}

interface Viewing {
  readonly viewer: string;
  readonly mailbox: Mailbox;
  touched: number;
}

function signalRelay(options: ScreenRelayOptions): {
  follow: Handle;
  deliver: Handle;
  issue: Handle;
} {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? relayHeartbeatMs;
  const sharer: Mailbox = { pending: [], stream: undefined };
  const sessions = new Map<string, Viewing>();

  const prune = (): void => {
    for (const [id, viewing] of sessions) {
      if (now() - viewing.touched <= relaySessionIdleMs) continue;
      viewing.mailbox.stream?.close();
      sessions.delete(id);
    }
  };

  const viewingFor = (sessionId: string, caller: MeshCaller): Viewing | string => {
    prune();
    const known = sessions.get(sessionId);
    if (known !== undefined && known.viewer !== caller.node.stableId)
      return `session ${sessionId} belongs to another viewer`;
    const viewing = known ?? {
      viewer: caller.node.stableId,
      mailbox: { pending: [], stream: undefined },
      touched: now(),
    };
    viewing.touched = now();
    sessions.set(sessionId, viewing);
    return viewing;
  };

  const forget = (sessionId: string): void => {
    sessions.get(sessionId)?.mailbox.stream?.close();
    sessions.delete(sessionId);
  };

  const fromSharer = (signal: ScreenSignal): Response => {
    const viewing = sessions.get(signal.sessionId);
    if (viewing === undefined)
      return refuse(404, `no viewer is waiting on session ${signal.sessionId}`);
    viewing.touched = now();
    post(viewing.mailbox, signal);
    if (signal.kind === "end" || signal.kind === "denied") forget(signal.sessionId);
    return new Response(null, { status: 204 });
  };

  const fromViewer = (signal: ScreenSignal, caller: MeshCaller, viewing: Viewing): Response => {
    if (signal.kind === "request" && sharer.stream === undefined)
      return refuse(503, `no console on ${options.machine()} is listening for screen requests`);
    post(sharer, signal.kind === "request" ? { ...signal, from: peerIdentityOf(caller) } : signal);
    if (signal.kind === "end") forget(signal.sessionId);
    else viewing.touched = now();
    return new Response(null, { status: 204 });
  };

  return {
    follow: async (request, caller) => {
      const party = partyOf(request);
      if (party === undefined) return refuse(400, unnamedParty);
      const admitted = await admit(options.tickets, request, caller, party);
      if (!admitted.ok) return refuse(admitted.status, admitted.problem);
      if (party.kind === "sharer") return open(sharer, heartbeatMs);
      const viewing = viewingFor(party.sessionId, caller);
      return typeof viewing === "string"
        ? refuse(403, viewing)
        : open(viewing.mailbox, heartbeatMs);
    },
    deliver: async (request, caller) => {
      const party = partyOf(request);
      if (party === undefined) return refuse(400, unnamedParty);
      const admitted = await admit(options.tickets, request, caller, party);
      if (!admitted.ok) return refuse(admitted.status, admitted.problem);
      const parsed = screenSignalSchema.safeParse(await bodyOf(request));
      if (!parsed.success) return badSignal(parsed.error.issues);
      const signal = parsed.data;
      if (party.kind === "sharer") return fromSharer(signal);
      if (signal.sessionId !== party.sessionId)
        return refuse(
          400,
          `the message names session ${signal.sessionId}, the URL ${party.sessionId}`,
        );
      const viewing = viewingFor(party.sessionId, caller);
      return typeof viewing === "string"
        ? refuse(403, viewing)
        : fromViewer(signal, caller, viewing);
    },
    issue: async (request, caller) => {
      const admitted = await admit(options.tickets, request, caller, { kind: "sharer" });
      if (!admitted.ok) return refuse(admitted.status, admitted.problem);
      const fields = ticketRequestOf(await bodyOf(request));
      if (fields === undefined)
        return refuse(400, "a screen ticket names a pairId and a sessionId");
      const issued = await options.tickets.issue(fields.pairId, fields.sessionId);
      if (issued === undefined) return refuse(404, `this machine holds no pair ${fields.pairId}`);
      return json(201, issued);
    },
  };
}

type Party = { kind: "sharer" } | { kind: "viewer"; sessionId: string };

const unnamedParty =
  "name the party: ?party=sharer for this house's console, ?session=<id> for a viewer";

function partyOf(request: Request): Party | undefined {
  const query = new URL(request.url).searchParams;
  if (query.get("party") === "sharer") return { kind: "sharer" };
  const sessionId = query.get("session");
  return sessionId === null || sessionId === "" ? undefined : { kind: "viewer", sessionId };
}

async function admit(
  tickets: ScreenTickets,
  request: Request,
  caller: MeshCaller,
  party: Party,
): Promise<TicketCheck> {
  const token = bearerOf(request);
  const check = await tickets.check(
    token,
    caller,
    party.kind === "viewer" ? party.sessionId : undefined,
  );
  if (check.ok && party.kind === "sharer" && check.holder !== "house")
    return { ok: false, status: 403, problem: "only this house's console shares its screen" };
  return check;
}

function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function post(mailbox: Mailbox, signal: ScreenSignal): void {
  const data = JSON.stringify(signal);
  if (mailbox.stream?.send(data)) return;
  mailbox.pending.push(data);
  if (mailbox.pending.length > relayMailboxLimit) mailbox.pending.shift();
}

function open(mailbox: Mailbox, heartbeatMs: number): Response {
  mailbox.stream?.close();
  const stream = eventStream(heartbeatMs, () => {
    if (mailbox.stream === stream) mailbox.stream = undefined;
  });
  mailbox.stream = stream;
  for (const data of mailbox.pending.splice(0)) stream.send(data);
  return new Response(stream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

interface EventStream {
  readonly body: ReadableStream<Uint8Array>;
  send(data: string): boolean;
  close(): void;
}

function eventStream(heartbeatMs: number, onClosed: () => void): EventStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    onClosed();
  };
  const write = (text: string): boolean => {
    if (closed || controller === undefined) return false;
    controller.enqueue(encoder.encode(text));
    return true;
  };
  const body = new ReadableStream<Uint8Array>({
    start: (opened) => {
      controller = opened;
      heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
      heartbeat.unref?.();
    },
    cancel: finish,
  });
  return {
    body,
    send: (data) => write(`data: ${data}\n\n`),
    close: () => {
      if (closed) return;
      controller?.close();
      finish();
    },
  };
}

function peerIdentityOf(caller: MeshCaller): PeerIdentity {
  const node = { stableId: caller.node.stableId, name: caller.node.name };
  const user =
    caller.human === null
      ? undefined
      : {
          id: caller.human.userId,
          loginName: caller.human.loginName,
          displayName: caller.human.displayName,
        };
  return { node, ...(user !== undefined && { user }), tags: [...caller.node.tags] };
}

function ticketRequestOf(body: unknown): { pairId: string; sessionId: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { pairId, sessionId } = body as Record<string, unknown>;
  if (typeof pairId !== "string" || typeof sessionId !== "string") return undefined;
  return { pairId, sessionId };
}

function badSignal(issues: readonly { path: PropertyKey[]; message: string }[]): Response {
  const first = issues[0];
  const where = first?.path.map(String).join(".") || "message";
  return json(400, {
    error: `the signal is malformed at ${where}: ${first?.message ?? "unreadable"}`,
    issues: issues.map(({ path, message }) => ({ path: path.map(String), message })),
  });
}

function refuse(status: number, problem: string): Response {
  return json(status, { error: problem });
}
