import type { BusEnvelope } from "./events.ts";
import type { AbortOutcome, PromptOutcome, SessionDetail, SessionSummary } from "./host.ts";
import { readServerTicket, type ServerTicket } from "./token.ts";

export interface KeyworkClient {
  readonly url: string;
  sessions(): Promise<readonly SessionSummary[]>;
  session(id: string): Promise<SessionDetail | undefined>;
  createSession(): Promise<SessionSummary>;
  prompt(id: string, text: string): Promise<PromptOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  events(options?: EventStreamOptions): AsyncIterable<BusEnvelope>;
}

export interface EventStreamOptions {
  since?: number | undefined;
  signal?: AbortSignal | undefined;
  onOpen?: (() => void) | undefined;
}

export interface SseFrame {
  id: string | undefined;
  event: string | undefined;
  data: string;
}

export type FrameReader = (body: ReadableStream<Uint8Array>) => AsyncIterable<SseFrame>;

export type Delay = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientSeams {
  fetch?: Fetch;
  readFrames?: FrameReader;
  delay?: Delay;
}

export class ServerRefusal extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "ServerRefusal";
  }
}

export interface TicketSources {
  file: string;
  url?: string | undefined;
  token?: string | undefined;
}

export function resolveServerTicket(sources: TicketSources): ServerTicket | undefined {
  if (sources.url !== undefined && sources.token !== undefined) {
    return { url: sources.url, token: sources.token };
  }
  const stored = readServerTicket(sources.file);
  if (stored === undefined) return undefined;
  return { url: sources.url ?? stored.url, token: sources.token ?? stored.token };
}

export function keyworkClient(ticket: ServerTicket, seams: ClientSeams = {}): KeyworkClient {
  const url = ticket.url.replace(/\/+$/, "");
  const call: Fetch = seams.fetch ?? fetch;
  const readFrames = seams.readFrames ?? sseFrames;
  const delay = seams.delay ?? sleep;
  const request = (method: string, path: string, body?: unknown, init: RequestInit = {}) =>
    call(`${url}${path}`, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${ticket.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return {
    url,
    sessions: async () => {
      const listed = await json<{ sessions: SessionSummary[] }>(await request("GET", "/sessions"));
      return listed.sessions;
    },
    session: async (id) => {
      const response = await request("GET", `/sessions/${encodeURIComponent(id)}`);
      return response.status === 404 ? undefined : json<SessionDetail>(response);
    },
    createSession: () => request("POST", "/sessions").then(json<SessionSummary>),
    prompt: async (id, text) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/prompt`, {
        text,
      });
      if (response.status === 404) return "missing";
      await json(response);
      return "accepted";
    },
    abort: async (id) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/abort`);
      if (response.status === 404) return "missing";
      const outcome = await json<{ interrupted: boolean }>(response);
      return outcome.interrupted ? "aborted" : "idle";
    },
    events: (options = {}) =>
      resumingEvents(
        options,
        (lastId) =>
          request("GET", "/events", undefined, {
            ...(options.signal !== undefined && { signal: options.signal }),
            headers: lastId === undefined ? {} : { "last-event-id": String(lastId) },
          }),
        readFrames,
        delay,
      ),
  };
}

export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end === -1) break;
        const frame = parseFrame(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        if (frame !== undefined) yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function envelopeOf(frame: SseFrame): BusEnvelope | undefined {
  if (frame.data === "") return undefined;
  try {
    return JSON.parse(frame.data) as BusEnvelope;
  } catch {
    return undefined;
  }
}

export const reconnectDelaysMs = { first: 250, ceiling: 5000 } as const;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(reconnectDelaysMs.first * 2 ** attempt, reconnectDelaysMs.ceiling);
}

async function* resumingEvents(
  options: EventStreamOptions,
  connect: (lastId: number | undefined) => Promise<Response>,
  readFrames: FrameReader,
  delay: Delay,
): AsyncIterable<BusEnvelope> {
  const { signal } = options;
  const aborted = (): boolean => signal?.aborted === true;
  let lastId = options.since;
  let attempt = 0;
  while (!aborted()) {
    const body = await openStream(connect, lastId, aborted);
    if (body !== undefined) {
      options.onOpen?.();
      try {
        for await (const frame of readFrames(body)) {
          if (frame.id !== undefined && /^\d+$/.test(frame.id)) lastId = Number(frame.id);
          const envelope = envelopeOf(frame);
          if (envelope === undefined) continue;
          attempt = 0;
          yield envelope;
        }
      } catch {
        if (aborted()) return;
      }
    }
    if (aborted()) return;
    await delay(reconnectDelayMs(attempt), signal);
    attempt += 1;
  }
}

async function openStream(
  connect: (lastId: number | undefined) => Promise<Response>,
  lastId: number | undefined,
  aborted: () => boolean,
): Promise<ReadableStream<Uint8Array> | undefined> {
  let response: Response;
  try {
    response = await connect(lastId);
  } catch {
    return undefined;
  }
  if (response.status === 401) throw new ServerRefusal(401, "the server refused the token");
  if (!response.ok || response.body === null || aborted()) return undefined;
  return response.body;
}

async function json<T = unknown>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  throw new ServerRefusal(response.status, await refusalDetail(response));
}

async function refusalDetail(response: Response): Promise<string> {
  if (response.status === 401) return "the server refused the token";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {}
  return `the server answered ${response.status}`;
}

function parseFrame(block: string): SseFrame | undefined {
  const frame: SseFrame = { id: undefined, event: undefined, data: "" };
  const data: string[] = [];
  let fields = 0;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    fields += 1;
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (name === "id") frame.id = value;
    else if (name === "event") frame.event = value;
    else if (name === "data") data.push(value);
  }
  if (fields === 0) return undefined;
  frame.data = data.join("\n");
  return frame;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
