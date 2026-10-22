import type {
  CandidateTriage,
  CloseDecisions,
  DailyEntry,
  EffortLevel,
  LedgerEntry,
  McpServerStatus,
  ModelReference,
  PermissionsView,
  QuestionTriage,
  ResolutionFailure,
  RevertOutcome,
  SendBehavior,
  SessionBinding,
  StagedItem,
  WriteResult,
} from "@keywork/engine";
import type { ActivePreset, AskScope, PermissionRule, PresetName } from "@keywork/shared";
import type { AnswerOutcome, AskVerdict, DenyReason, PendingAsk } from "./asks.ts";
import type { BusEnvelope } from "./events.ts";
import type { ByteRange, FileSlice, TreeListing } from "./files.ts";
import type {
  AbortOutcome,
  AirlockFinishOutcome,
  ArcCloseDigestRecord,
  ArcCloseOutcome,
  ArcSummary,
  BotDraft,
  BotEntry,
  BotSummary,
  ChangesReport,
  CompactionReport,
  ExportScope,
  LabelOutcome,
  LeafOutcome,
  MemoryNoteDetail,
  MemoryNoteRecord,
  MemoryOverview,
  MemoryQueryOutcome,
  PromptOutcome,
  RedoReport,
  RestoreReport,
  SessionDetail,
  SessionEntries,
  SessionSummary,
  ThemesReport,
  TrustGrant,
  UndoReport,
  WorkspaceChoice,
  WorkspaceReport,
} from "./host.ts";
import type { OpenApiDocument } from "./openapi.ts";
import { askRefusals } from "./routes/asks.ts";
import type { FileChange } from "./routes/changes.ts";
import type { ContextAnswer, CostAnswer } from "./routes/session-verbs.ts";
import { readServerTicket, type ServerTicket } from "./token.ts";

export type ModelAnswer =
  | { model: ModelReference; notice: string }
  | { failure: ResolutionFailure };

export type ExportAnswer = { html: string } | { file: string };

export type GrantRevocation = "revoked" | "missing" | "malformed";

export type GrantAnswer = "granted" | "missing" | "malformed";

export interface PresetAnswer {
  from: ActivePreset;
  to: PresetName;
}

export interface KeyworkClient {
  readonly url: string;
  document(): Promise<OpenApiDocument>;
  sessions(): Promise<readonly SessionSummary[]>;
  session(id: string): Promise<SessionDetail | undefined>;
  createSession(): Promise<SessionSummary>;
  prompt(id: string, text: string, behavior?: SendBehavior): Promise<PromptOutcome>;
  abort(id: string): Promise<AbortOutcome>;
  setModel(id: string, reference: string): Promise<ModelAnswer | undefined>;
  setThinking(id: string, on: boolean): Promise<{ thinking: boolean } | undefined>;
  setEffort(
    id: string,
    level: EffortLevel | null,
  ): Promise<{ effort: EffortLevel | null } | undefined>;
  compact(id: string, focus?: string): Promise<CompactionReport | undefined>;
  undo(id: string): Promise<UndoReport | "missing" | "nothing">;
  redo(id: string): Promise<RedoReport | "missing" | "nothing">;
  restoreTurn(id: string, turn: number): Promise<RestoreReport | "missing" | "unknown-turn">;
  context(id: string): Promise<ContextAnswer | undefined>;
  cost(id: string): Promise<CostAnswer | undefined>;
  exportSession(id: string, scope?: ExportScope, out?: string): Promise<ExportAnswer | undefined>;
  rename(id: string, title: string): Promise<{ title: string } | undefined>;
  applyPreset(name: PresetName, confirmed?: boolean): Promise<PresetAnswer>;
  asks(): Promise<readonly PendingAsk[]>;
  answerAsk(
    callId: string,
    verdict: AskVerdict,
    scope?: AskScope,
    reason?: DenyReason,
  ): Promise<AnswerOutcome>;
  listPermissions(): Promise<PermissionsView>;
  grantWorkspaceRule(rule: PermissionRule): Promise<GrantAnswer>;
  grantSessionRule(sessionId: string, rule: PermissionRule): Promise<GrantAnswer>;
  revokeWorkspaceGrant(rule: PermissionRule): Promise<GrantRevocation>;
  revokeSessionGrant(sessionId: string, rule: PermissionRule): Promise<GrantRevocation>;
  events(options?: EventStreamOptions): AsyncIterable<BusEnvelope>;
  memory(): Promise<Trusted<MemoryOverview>>;
  memoryInbox(): Promise<Trusted<{ items: StagedItem[]; count: number }>>;
  approveStagedItem(id: string): Promise<WriteResult | Record<string, never>>;
  discardStagedItem(id: string): Promise<void>;
  memoryNotes(layer?: string): Promise<Trusted<{ notes: CuredNote[] }>>;
  memoryNote(name: string): Promise<CuredNoteDetail | undefined>;
  memoryDailyDates(): Promise<Trusted<{ dates: string[] }>>;
  memoryDaily(date: string): Promise<Trusted<{ date: string; entries: DailyEntry[] }>>;
  memoryLedger(): Promise<Trusted<{ entries: LedgerEntry[] }>>;
  revertMemoryLedgerEntry(id: string): Promise<RevertOutcome>;
  askMemory(query: string, arc?: string): Promise<Trusted<MemoryQueryOutcome>>;
  airlock(slug: string): Promise<Trusted<AirlockDigest> | undefined>;
  triageAirlockCandidate(
    slug: string,
    note: string,
    choice: CandidateTriage,
  ): Promise<Trusted<AirlockDigest>>;
  triageAirlockQuestion(
    slug: string,
    title: string,
    choice: QuestionTriage,
  ): Promise<Trusted<AirlockDigest>>;
  deliverAirlock(slug: string): Promise<{ delivered: number }>;
  finishAirlock(slug: string, options?: { force?: boolean }): Promise<AirlockFinishOutcome>;
  workspace(): Promise<WorkspaceReport>;
  trustWorkspace(): Promise<TrustGrant>;
  tree(path?: string, hidden?: boolean): Promise<TreeListing>;
  file(path: string, range?: ByteRange): Promise<FileSlice>;
  mcpServers(): Promise<McpServerStatus[]>;
  restartMcpServer(name: string): Promise<McpServerStatus | undefined>;
  setMcpServerEnabled(name: string, on: boolean): Promise<McpServerStatus | undefined>;
  mcpServerTools(name: string): Promise<string[]>;
  arcs(): Promise<ArcsAnswer>;
  createArc(slug: string): Promise<ArcSummary>;
  closeArc(slug: string, direction?: string): Promise<ArcCloseOutcome>;
  abandonArc(slug: string): Promise<void>;
  bindSessionArc(id: string, slug: string | null): Promise<SessionBinding | undefined>;
  bindSessionBot(id: string, name: string | null): Promise<SessionBinding | undefined>;
  bots(): Promise<BotSummary[]>;
  createBot(draft: BotDraft): Promise<BotEntry>;
  workspaces(): Promise<WorkspaceChoice[]>;
  createWorkspace(slug: string): Promise<void>;
  useWorkspace(slug: string | null): Promise<{ slug: string | null; reopens: boolean }>;
  focusWorkspaceDir(slug: string | null, dir: string): Promise<string>;
  unfocusWorkspaceDir(slug: string | null, dir: string): Promise<void>;
  themes(): Promise<ThemesReport>;
  entries(id: string): Promise<SessionEntries | undefined>;
  fork(id: string, entryId: string): Promise<{ sessionId: string } | undefined>;
  labelEntry(id: string, entryId: string, label: string | null): Promise<LabelOutcome | undefined>;
  moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome | undefined>;
  changes(id: string): Promise<ChangesReport | undefined>;
  changedFile(id: string, path: string): Promise<FileChange | undefined>;
  removeSession(id: string): Promise<SessionSummary | "missing" | "busy">;
  trash(): Promise<readonly SessionSummary[]>;
  restoreSession(id: string): Promise<SessionSummary | undefined>;
  discardTrashedSession(id: string): Promise<boolean>;
  purgeTrash(): Promise<{ purged: number }>;
}

export interface ArcsAnswer {
  arcs: ArcSummary[];
  ordinals: Record<string, number>;
}

export type Trusted<Shape> = Shape & { trusted: boolean };

export type CuringStage = 0 | 1 | 2 | 3;

export type CuredNote = MemoryNoteRecord & { curing: CuringStage };

export type CuredNoteDetail = Trusted<MemoryNoteDetail> & { curing: CuringStage };

export type AirlockDigest = ArcCloseDigestRecord & { decisions: CloseDecisions };

export interface EventStreamOptions {
  since?: number | undefined;
  signal?: AbortSignal | undefined;
  onOpen?: (() => void) | undefined;
  session?: string | undefined;
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
    document: () => request("GET", "/doc").then(json<OpenApiDocument>),
    sessions: async () => {
      const listed = await json<{ sessions: SessionSummary[] }>(await request("GET", "/sessions"));
      return listed.sessions;
    },
    session: async (id) => {
      const response = await request("GET", `/sessions/${encodeURIComponent(id)}`);
      return response.status === 404 ? undefined : json<SessionDetail>(response);
    },
    createSession: () => request("POST", "/sessions").then(json<SessionSummary>),
    prompt: async (id, text, behavior) => {
      const response = await request("POST", `/sessions/${encodeURIComponent(id)}/prompt`, {
        text,
        ...(behavior !== undefined && { behavior }),
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
    setModel: async (id, reference) => {
      const response = await request("POST", sessionPath(id, "model"), { reference });
      if (response.status === 404) return undefined;
      if (response.status === 400) {
        const refusal = (await response.json()) as { failure?: ResolutionFailure };
        if (refusal.failure !== undefined) return { failure: refusal.failure };
        throw new ServerRefusal(400, "the server refused the reference");
      }
      return json<ModelAnswer>(response);
    },
    setThinking: (id, on) => unlessMissing(request("POST", sessionPath(id, "thinking"), { on })),
    setEffort: (id, level) => unlessMissing(request("POST", sessionPath(id, "effort"), { level })),
    compact: (id, focus) =>
      unlessMissing(
        request("POST", sessionPath(id, "compact"), focus === undefined ? {} : { focus }),
      ),
    undo: (id) => timeTravel(request("POST", sessionPath(id, "undo"))),
    redo: (id) => timeTravel(request("POST", sessionPath(id, "redo"))),
    restoreTurn: async (id, turn) => {
      const response = await request("POST", sessionPath(id, "restore"), { turn });
      if (response.status !== 404) return json<RestoreReport>(response);
      const detail = await refusalDetail(response);
      return detail.startsWith("no turn") ? "unknown-turn" : "missing";
    },
    context: (id) => unlessMissing(request("GET", sessionPath(id, "context"))),
    cost: (id) => unlessMissing(request("GET", sessionPath(id, "cost"))),
    exportSession: async (id, scope = "path", out) => {
      const response = await request("POST", sessionPath(id, "export"), {
        scope,
        ...(out !== undefined && { out }),
      });
      if (response.status === 404) return undefined;
      if (response.status === 201) return json<{ file: string }>(response);
      if (!response.ok) throw new ServerRefusal(response.status, await refusalDetail(response));
      return { html: await response.text() };
    },
    rename: (id, title) => unlessMissing(request("POST", sessionPath(id, "rename"), { title })),
    applyPreset: (name, confirmed) =>
      request("POST", "/preset", { name, ...(confirmed === true && { confirmed }) }).then(
        json<PresetAnswer>,
      ),
    asks: async () => {
      const listed = await json<{ asks: PendingAsk[] }>(await request("GET", "/asks"));
      return listed.asks;
    },
    answerAsk: async (callId, verdict, scope, reason) => {
      const response = await request("POST", `/asks/${encodeURIComponent(callId)}`, {
        verdict,
        ...(scope !== undefined && { scope }),
        ...(reason !== undefined && { reason }),
      });
      if (response.status === 404) return "missing";
      if (response.status === 409) return "already-settled";
      if (response.status === 400) {
        const refusal = askRefusalOf(await refusalDetail(response));
        if (refusal !== undefined) return refusal;
        throw new ServerRefusal(400, "the server refused the answer");
      }
      await json(response);
      return "settled";
    },
    listPermissions: () => request("GET", "/permissions").then(json<PermissionsView>),
    grantWorkspaceRule: (rule) =>
      granting(request("POST", "/permissions/workspace/grant", { rule })),
    grantSessionRule: (sessionId, rule) =>
      granting(
        request("POST", `/permissions/session/${encodeURIComponent(sessionId)}/grant`, { rule }),
      ),
    revokeWorkspaceGrant: (rule) =>
      revocation(request("POST", "/permissions/workspace/revoke", { rule })),
    revokeSessionGrant: (sessionId, rule) =>
      revocation(
        request("POST", `/permissions/session/${encodeURIComponent(sessionId)}/revoke`, { rule }),
      ),
    memory: () => request("GET", "/memory").then(json<Trusted<MemoryOverview>>),
    memoryInbox: () =>
      request("GET", "/memory/inbox").then(json<Trusted<{ items: StagedItem[]; count: number }>>),
    approveStagedItem: (id) =>
      request("POST", `/memory/inbox/${encodeURIComponent(id)}/approve`).then(
        json<WriteResult | Record<string, never>>,
      ),
    discardStagedItem: async (id) => {
      await json(await request("POST", `/memory/inbox/${encodeURIComponent(id)}/discard`));
    },
    memoryNotes: (layer) =>
      request(
        "GET",
        layer === undefined ? "/memory/notes" : `/memory/notes?layer=${encodeURIComponent(layer)}`,
      ).then(json<Trusted<{ notes: CuredNote[] }>>),
    memoryNote: async (name) => {
      const response = await request("GET", `/memory/notes/${encodeURIComponent(name)}`);
      return response.status === 404 ? undefined : json<CuredNoteDetail>(response);
    },
    memoryDailyDates: () =>
      request("GET", "/memory/daily").then(json<Trusted<{ dates: string[] }>>),
    memoryDaily: (date) =>
      request("GET", `/memory/daily/${encodeURIComponent(date)}`).then(
        json<Trusted<{ date: string; entries: DailyEntry[] }>>,
      ),
    memoryLedger: () =>
      request("GET", "/memory/ledger").then(json<Trusted<{ entries: LedgerEntry[] }>>),
    revertMemoryLedgerEntry: async (id) => {
      const response = await request("POST", `/memory/ledger/${encodeURIComponent(id)}/revert`);
      return (await json<{ outcome: RevertOutcome }>(response)).outcome;
    },
    askMemory: (query, arc) =>
      request("POST", "/memory/ask", { query, ...(arc !== undefined && { arc }) }).then(
        json<Trusted<MemoryQueryOutcome>>,
      ),
    airlock: async (slug) => {
      const response = await request("GET", `/arcs/${encodeURIComponent(slug)}/airlock`);
      return response.status === 404 ? undefined : json<Trusted<AirlockDigest>>(response);
    },
    triageAirlockCandidate: (slug, note, choice) =>
      request(
        "POST",
        `/arcs/${encodeURIComponent(slug)}/airlock/candidates/${encodeURIComponent(note)}`,
        { choice },
      ).then(json<Trusted<AirlockDigest>>),
    triageAirlockQuestion: (slug, title, choice) =>
      request("POST", `/arcs/${encodeURIComponent(slug)}/airlock/questions`, {
        title,
        choice,
      }).then(json<Trusted<AirlockDigest>>),
    deliverAirlock: (slug) =>
      request("POST", `/arcs/${encodeURIComponent(slug)}/airlock/deliver`).then(
        json<{ delivered: number }>,
      ),
    finishAirlock: (slug, options = {}) =>
      request("POST", `/arcs/${encodeURIComponent(slug)}/airlock/finish`, {
        force: options.force === true,
      }).then(json<AirlockFinishOutcome>),
    workspace: () => request("GET", "/workspace").then(json<WorkspaceReport>),
    trustWorkspace: () => request("POST", "/workspace/trust").then(json<TrustGrant>),
    tree: (path = "", hidden = false) =>
      request("GET", `/tree?${queryOf({ path, hidden: hidden ? "true" : undefined })}`).then(
        json<TreeListing>,
      ),
    file: (path, range = {}) =>
      request("GET", `/files?${queryOf({ path, from: range.from, to: range.to })}`).then(
        json<FileSlice>,
      ),
    mcpServers: async () =>
      (await json<{ servers: McpServerStatus[] }>(await request("GET", "/mcp"))).servers,
    restartMcpServer: (name) =>
      request("POST", `/mcp/${encodeURIComponent(name)}/restart`).then(
        json<McpServerStatus | undefined>,
      ),
    setMcpServerEnabled: (name, on) =>
      request("POST", `/mcp/${encodeURIComponent(name)}/enabled`, { on }).then(
        json<McpServerStatus | undefined>,
      ),
    mcpServerTools: async (name) =>
      (
        await json<{ tools: string[] }>(
          await request("GET", `/mcp/${encodeURIComponent(name)}/tools`),
        )
      ).tools,
    arcs: () => request("GET", "/arcs").then(json<ArcsAnswer>),
    createArc: (slug) => request("POST", "/arcs", { slug }).then(json<ArcSummary>),
    closeArc: (slug, direction) =>
      request("POST", `/arcs/${encodeURIComponent(slug)}/close`, {
        ...(direction !== undefined && { direction }),
      }).then(json<ArcCloseOutcome>),
    abandonArc: async (slug) => {
      await json(await request("POST", `/arcs/${encodeURIComponent(slug)}/abandon`));
    },
    bindSessionArc: (id, slug) => unlessMissing(request("POST", sessionPath(id, "arc"), { slug })),
    bindSessionBot: (id, name) => unlessMissing(request("POST", sessionPath(id, "bot"), { name })),
    bots: async () => (await json<{ bots: BotSummary[] }>(await request("GET", "/bots"))).bots,
    createBot: (draft) => request("POST", "/bots", draft).then(json<BotEntry>),
    workspaces: async () =>
      (await json<{ workspaces: WorkspaceChoice[] }>(await request("GET", "/workspaces")))
        .workspaces,
    createWorkspace: async (slug) => {
      await json(await request("POST", "/workspaces", { slug }));
    },
    useWorkspace: (slug) =>
      request("POST", "/workspaces/use", { slug }).then(
        json<{ slug: string | null; reopens: boolean }>,
      ),
    focusWorkspaceDir: async (slug, dir) =>
      (await json<{ dir: string }>(await request("POST", workspacePath(slug, "focus"), { dir })))
        .dir,
    unfocusWorkspaceDir: async (slug, dir) => {
      await json(await request("POST", workspacePath(slug, "unfocus"), { dir }));
    },
    themes: () => request("GET", "/themes").then(json<ThemesReport>),
    entries: (id) => unlessMissing(request("GET", sessionPath(id, "entries"))),
    fork: (id, entryId) => unlessMissing(request("POST", sessionPath(id, "fork"), { entryId })),
    labelEntry: (id, entryId, label) =>
      unlessMissing(request("POST", sessionPath(id, "label"), { entryId, label })),
    moveLeaf: (id, entryId) => unlessMissing(request("POST", sessionPath(id, "leaf"), { entryId })),
    changes: (id) => unlessMissing(request("GET", sessionPath(id, "changes"))),
    changedFile: (id, path) =>
      unlessMissing(request("GET", `${sessionPath(id, "changes/file")}?${queryOf({ path })}`)),
    removeSession: async (id) => {
      const response = await request("DELETE", `/sessions/${encodeURIComponent(id)}`);
      if (response.status === 404) return "missing";
      if (response.status === 409) return "busy";
      return json<SessionSummary>(response);
    },
    trash: async () => {
      const listed = await json<{ sessions: SessionSummary[] }>(await request("GET", "/trash"));
      return listed.sessions;
    },
    restoreSession: (id) => unlessMissing(request("POST", trashPath(id, "restore"))),
    discardTrashedSession: async (id) => {
      const response = await request("DELETE", `/trash/${encodeURIComponent(id)}`);
      if (response.status === 404) return false;
      await json(response);
      return true;
    },
    purgeTrash: () => request("DELETE", "/trash").then(json<{ purged: number }>),
    events: (options = {}) =>
      resumingEvents(
        options,
        (lastId) =>
          request("GET", eventsPath(options.session), undefined, {
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

function sessionPath(id: string, verb: string): string {
  return `/sessions/${encodeURIComponent(id)}/${verb}`;
}

function trashPath(id: string, verb: string): string {
  return `/trash/${encodeURIComponent(id)}/${verb}`;
}

function workspacePath(slug: string | null, verb: string): string {
  return `/workspaces/${encodeURIComponent(slug ?? "default")}/${verb}`;
}

function queryOf(fields: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) query.set(name, String(value));
  }
  return query.toString();
}

function eventsPath(session: string | undefined): string {
  return session === undefined ? "/events" : `/events?session=${encodeURIComponent(session)}`;
}

async function unlessMissing<T>(pending: Promise<Response>): Promise<T | undefined> {
  const response = await pending;
  return response.status === 404 ? undefined : json<T>(response);
}

async function timeTravel<T>(pending: Promise<Response>): Promise<T | "missing" | "nothing"> {
  const response = await pending;
  if (response.status !== 404) return json<T>(response);
  const detail = await refusalDetail(response);
  return detail.startsWith("nothing to") ? "nothing" : "missing";
}

async function granting(pending: Promise<Response>): Promise<GrantAnswer> {
  const response = await pending;
  if (response.status === 404) return "missing";
  if (response.status === 400) return "malformed";
  await json(response);
  return "granted";
}

async function revocation(pending: Promise<Response>): Promise<GrantRevocation> {
  const response = await pending;
  if (response.status === 404) return "missing";
  if (response.status === 400) return "malformed";
  await json(response);
  return "revoked";
}

function askRefusalOf(error: string): Exclude<AnswerOutcome, "settled"> | undefined {
  const refusals = Object.entries(askRefusals) as [keyof typeof askRefusals, string][];
  return refusals.find(([, message]) => message === error)?.[0];
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
