import type { EffortLevel, ModelReference, ResolutionFailure, SendBehavior } from "@keywork/engine";
import type { AskScope, PresetName } from "@keywork/shared";
import type { AnswerOutcome, AskVerdict, PendingAsk } from "./asks.ts";
import type { BusEnvelope } from "./events.ts";
import type {
  AbortOutcome,
  ChangedFile,
  CompactOutcome,
  ContextReport,
  CostReport,
  EffortOutcome,
  ExportOutcome,
  ExportRequest,
  FileRange,
  ForkOutcome,
  LabelOutcome,
  LeafOutcome,
  ModelOutcome,
  PresetOutcome,
  PromptOutcome,
  RedoOutcome,
  RenameOutcome,
  SessionChanges,
  SessionDetail,
  SessionEntries,
  SessionSummary,
  SpillSlice,
  ThinkingOutcome,
  UndoOutcome,
} from "./host.ts";
import { askRefusals } from "./routes/asks.ts";
import { readServerTicket, type ServerTicket } from "./token.ts";

export interface KeyworkClient {
  readonly url: string;
  sessions(): Promise<readonly SessionSummary[]>;
  session(id: string): Promise<SessionDetail | undefined>;
  createSession(): Promise<SessionSummary>;
  prompt(id: string, text: string, behavior?: SendBehavior): Promise<PromptOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  entries(id: string): Promise<SessionEntries | undefined>;
  fork(id: string, entryId: string): Promise<ForkOutcome>;
  label(id: string, entryId: string, label: string | null): Promise<LabelOutcome>;
  moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome>;
  changes(id: string): Promise<ChangesReading | undefined>;
  changedFile(id: string, path: string): Promise<ChangedFileReading | undefined>;
  spill(id: string, spillId: string, range?: FileRange): Promise<SpillSlice | undefined>;
  setModel(id: string, reference: string): Promise<ModelOutcome>;
  setThinking(id: string, on: boolean): Promise<ThinkingOutcome>;
  setEffort(id: string, level: EffortLevel | null): Promise<EffortOutcome>;
  compact(id: string, focus?: string): Promise<CompactOutcome>;
  undo(id: string): Promise<UndoOutcome>;
  redo(id: string): Promise<RedoOutcome>;
  context(id: string): Promise<ContextReport | "missing">;
  cost(id: string): Promise<CostReport | "missing">;
  exportSession(id: string, request?: Partial<ExportRequest>): Promise<ExportOutcome>;
  rename(id: string, title: string): Promise<RenameOutcome>;
  setPreset(name: PresetName, confirmed?: boolean): Promise<PresetOutcome>;
  asks(): Promise<readonly PendingAsk[]>;
  answerAsk(callId: string, verdict: AskVerdict, scope?: AskScope): Promise<AnswerOutcome>;
  events(options?: EventStreamOptions): AsyncIterable<BusEnvelope>;
}

export type ChangesReading =
  | ({ trusted: true } & SessionChanges)
  | { trusted: false; files: readonly [] }
  | "no-baseline";

export type ChangedFileReading =
  | ({ trusted: true } & ChangedFile)
  | { trusted: false; path: string; before: null; after: null; truncated: false }
  | "no-baseline";

export interface EventStreamOptions {
  since?: number | undefined;
  session?: string | undefined;
  only?: "session" | undefined;
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
  const sessionPath = (id: string, verb: string) => `/sessions/${encodeURIComponent(id)}/${verb}`;
  const verb = (id: string, name: string, body?: unknown) =>
    request("POST", sessionPath(id, name), body);
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
    prompt: async (id, text, behavior = "queue") => {
      const response = await verb(id, "prompt", { text, behavior });
      if (response.status === 404) return "missing";
      const accepted = await json<{ queued: boolean }>(response);
      return accepted.queued ? "queued" : "started";
    },
    abort: async (id) => {
      const response = await verb(id, "abort");
      if (response.status === 404) return "missing";
      const outcome = await json<{ interrupted: boolean }>(response);
      return outcome.interrupted ? "aborted" : "idle";
    },
    entries: async (id) => {
      const response = await request("GET", `/sessions/${encodeURIComponent(id)}/entries`);
      return response.status === 404 ? undefined : json<SessionEntries>(response);
    },
    fork: async (id, entryId) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/fork`, {
        entryId,
      });
      if (response.status === 404) return await missingOf(response);
      return json<SessionSummary>(response);
    },
    label: async (id, entryId, label) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/label`, {
        entryId,
        label,
      });
      if (response.status === 404) return await missingOf(response);
      await json(response);
      return "labelled";
    },
    moveLeaf: async (id, entryId) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/leaf`, {
        entryId,
      });
      if (response.status === 404) return await missingOf(response);
      if (response.status === 409) return "busy";
      return json<{ leafId: string | null }>(response);
    },
    changes: async (id) => {
      const response = await request("GET", `/sessions/${encodeURIComponent(id)}/changes`);
      if (response.status === 404) return undefined;
      if (response.status === 409) return "no-baseline";
      return json<ChangesReading>(response);
    },
    changedFile: async (id, path) => {
      const query = new URLSearchParams({ path });
      const response = await request(
        "GET",
        `/sessions/${encodeURIComponent(id)}/changes/file?${query}`,
      );
      if (response.status === 404) return undefined;
      if (response.status === 409) return "no-baseline";
      return json<ChangedFileReading>(response);
    },
    spill: async (id, spillId, range = {}) => {
      const query = rangeQueryOf(range);
      const response = await request(
        "GET",
        `${sessionPath(id, "spills")}/${encodeURIComponent(spillId)}${query}`,
      );
      return response.status === 404 ? undefined : json<SpillSlice>(response);
    },
    setModel: async (id, reference) => {
      const response = await verb(id, "model", { reference });
      if (response.status === 404) return "missing";
      if (response.status === 409) return "busy";
      if (response.status === 400) {
        const refused = (await response.json()) as { error: string; failure?: ResolutionFailure };
        if (refused.failure !== undefined) return { ok: false, failure: refused.failure };
        throw new ServerRefusal(400, refused.error);
      }
      const set = await json<{ model: ModelReference; notice: string }>(response);
      return { ok: true, ...set };
    },
    setThinking: async (id, on) => {
      const response = await verb(id, "thinking", { on });
      return response.status === 404 ? "missing" : json<{ thinking: boolean }>(response);
    },
    setEffort: async (id, level) => {
      const response = await verb(id, "effort", { level });
      return response.status === 404 ? "missing" : json<{ effort: EffortLevel | null }>(response);
    },
    compact: async (id, focus) => {
      const response = await verb(id, "compact", focus === undefined ? {} : { focus });
      if (response.status === 404) return "missing";
      if (response.status === 409) return "busy";
      return json<CompactOutcome & object>(response);
    },
    undo: async (id) => {
      const response = await verb(id, "undo");
      if (response.status === 404)
        return (await errorOf(response)) === missingSessionError ? "missing" : "nothing";
      if (response.status === 409)
        return (await errorOf(response)) === turnRunningError ? "busy" : "staged";
      return json<UndoOutcome & object>(response);
    },
    redo: async (id) => {
      const response = await verb(id, "redo");
      if (response.status === 404)
        return (await errorOf(response)) === missingSessionError ? "missing" : "nothing";
      if (response.status === 409) return "busy";
      return json<RedoOutcome & object>(response);
    },
    context: async (id) => {
      const response = await request("GET", sessionPath(id, "context"));
      return response.status === 404 ? "missing" : json<ContextReport>(response);
    },
    cost: async (id) => {
      const response = await request("GET", sessionPath(id, "cost"));
      return response.status === 404 ? "missing" : json<CostReport>(response);
    },
    exportSession: async (id, exportRequest = {}) => {
      const response = await verb(id, "export", {
        scope: exportRequest.scope ?? "path",
        ...(exportRequest.out !== undefined && { out: exportRequest.out }),
      });
      if (response.status === 404) return "missing";
      if (response.status === 403) return { refused: await errorOf(response) };
      if (response.status === 201) return json<{ file: string }>(response);
      if (!response.ok) throw new ServerRefusal(response.status, await refusalDetail(response));
      return { html: await response.text() };
    },
    rename: async (id, title) => {
      const response = await verb(id, "rename", { title });
      return response.status === 404 ? "missing" : json<{ title: string }>(response);
    },
    setPreset: async (name, confirmed = false) => {
      const response = await request("POST", "/preset", {
        name,
        ...(confirmed && { confirmed: true }),
      });
      if (response.status === 409) {
        return (await errorOf(response)) === loosening ? "needs-confirmation" : "unavailable";
      }
      return json<PresetOutcome & object>(response);
    },
    asks: async () => {
      const listed = await json<{ asks: PendingAsk[] }>(await request("GET", "/asks"));
      return listed.asks;
    },
    answerAsk: async (callId, verdict, scope) => {
      const response = await request("POST", `/asks/${encodeURIComponent(callId)}`, {
        verdict,
        ...(scope !== undefined && { scope }),
      });
      if (response.status === 404) return "missing";
      if (response.status === 409) return "already-settled";
      if (response.status === 400) {
        const refusal = askRefusalOf(await errorOf(response));
        if (refusal !== undefined) return refusal;
        throw new ServerRefusal(400, "the server refused the answer");
      }
      await json(response);
      return "settled";
    },
    events: (options = {}) =>
      resumingEvents(
        options,
        (lastId) =>
          request("GET", eventsPath(options), undefined, {
            ...(options.signal !== undefined && { signal: options.signal }),
            headers: lastId === undefined ? {} : { "last-event-id": String(lastId) },
          }),
        readFrames,
        delay,
      ),
  };
}

const missingSessionError = "no session has that id";
const turnRunningError = "a turn is running";
const loosening = "loosening needs confirmed: true";

function eventsPath(options: EventStreamOptions): string {
  if (options.session === undefined) return "/events";
  const query = new URLSearchParams({ session: options.session });
  if (options.only !== undefined) query.set("only", options.only);
  return `/events?${query}`;
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

function rangeQueryOf(range: FileRange): string {
  const query = new URLSearchParams();
  if (range.from !== undefined) query.set("from", String(range.from));
  if (range.to !== undefined) query.set("to", String(range.to));
  return query.size === 0 ? "" : `?${query}`;
}

async function json<T = unknown>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  throw new ServerRefusal(response.status, await refusalDetail(response));
}

function askRefusalOf(error: string): Exclude<AnswerOutcome, "settled"> | undefined {
  const refusals = Object.entries(askRefusals) as [keyof typeof askRefusals, string][];
  return refusals.find(([, message]) => message === error)?.[0];
}

async function errorOf(response: Response): Promise<string> {
  return refusalDetail(response);
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

async function missingOf(response: Response): Promise<"missing" | "unknown-entry"> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error === "no entry has that entryId" ? "unknown-entry" : "missing";
}
