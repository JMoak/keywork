import { MemoryGraph } from "@keywork/engine";
import type {
  AirlockDigest,
  ArcCloseDigestRecord,
  BusEnvelope,
  CuredNote,
  FileChange,
  KeyworkClient,
  MemoryOverview,
  Trusted,
} from "@keywork/server";
import type {
  AirlockDigestView,
  ArcAirlockPort,
  ArcsPort,
  BotEntry,
  BotsPort,
  ChangedFile,
  ContextReadings,
  ContextSubject,
  DiffPort,
  McpPanePort,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryPanePort,
  WorkspaceFilesPort,
  WorkspacesPort,
} from "@keywork/tui";
import { serverView } from "./mcp.ts";
import { auditView, inboxView, lastSweep, ledgerOpView, noteView } from "./memory.ts";
import type { ServerFeed } from "./remote-ports.ts";

export interface ServedPanes {
  files: WorkspaceFilesPort;
  diff: DiffPort;
  memory: MemoryPanePort;
  mcp: McpPanePort;
  arcs: ArcsPort;
  bots: BotsPort;
  workspaces: WorkspacesPort;
  contextReadings: ContextReadings;
}

export type SessionChoice = () => Promise<string | undefined>;

export function servedSpillPath(sessionId: string, spillId: string): string {
  return `${spillScheme}${sessionId}/${spillId}`;
}

export const attachedWorkspaceSwitch =
  "an attached client can't switch the server's workspace · restart keywork serve in that workspace";

export function servedPanes(
  client: KeyworkClient,
  feed: ServerFeed,
  session: SessionChoice,
): ServedPanes {
  const airlock = servedAirlock(client);
  return {
    files: servedFiles(client),
    diff: servedDiff(client, feed, session),
    memory: servedMemory(client, airlock),
    mcp: servedMcp(client, feed),
    arcs: servedArcs(client, feed, airlock),
    bots: servedBots(client, feed),
    workspaces: servedWorkspaces(client),
    contextReadings: servedContextReadings(client, feed, session),
  };
}

export function servedFiles(client: KeyworkClient): WorkspaceFilesPort {
  return {
    disk: {
      readDirectory: async (path) => {
        const listing = await client.tree(workspacePath(path));
        return listing.entries
          .filter((entry) => !entry.ignored)
          .map(({ name, kind }) => ({ name, kind }));
      },
    },
    read: (path) =>
      path.startsWith(spillScheme) ? servedSpill(client, path) : servedFile(client, path),
  };
}

async function servedFile(client: KeyworkClient, path: string): Promise<string> {
  return (await client.file(workspacePath(path))).text;
}

async function servedSpill(client: KeyworkClient, path: string): Promise<string> {
  const [sessionId = "", spillId = ""] = path.slice(spillScheme.length).split("/");
  const slice = await client.spill(sessionId, spillId);
  if (slice === undefined) throw new Error("that spill is gone from the server");
  return slice.text;
}

const spillScheme = "spill:";

export function servedDiff(
  client: KeyworkClient,
  feed: ServerFeed,
  session: SessionChoice,
): DiffPort {
  let sides = new Map<string, Promise<FileChange | undefined>>();
  const sidesOf = async (path: string): Promise<FileChange | undefined> => {
    const sessionId = await session();
    if (sessionId === undefined) return undefined;
    const known = sides.get(path) ?? client.changedFile(sessionId, path);
    sides.set(path, known);
    return known;
  };
  return {
    baseline: {
      label: "session start",
      changes: async (): Promise<ChangedFile[]> => {
        sides = new Map();
        const sessionId = await session();
        const report = sessionId === undefined ? undefined : await client.changes(sessionId);
        return report === undefined ? [] : [...report.files];
      },
      before: async (path) => (await sidesOf(path))?.before ?? undefined,
    },
    readFile: async (path) => (await sidesOf(path))?.after ?? undefined,
    follow: {
      subscribe: (listener) =>
        feed.subscribe((envelope) => {
          if (envelope.type === "changes.updated") listener();
        }),
    },
  };
}

export function servedMemory(client: KeyworkClient, airlock: ArcAirlockPort): MemoryPanePort {
  return {
    load: async () => {
      const [overview, listed] = await Promise.all([client.memory(), client.memoryNotes()]);
      return overview.trusted ? servedInputs(overview, listed.notes) : emptyMemory;
    },
    approve: async (id) => {
      await client.approveStagedItem(id);
    },
    discard: (id) => client.discardStagedItem(id),
    revert: (ledgerId) => client.revertMemoryLedgerEntry(ledgerId),
    query: async (text, arc) => {
      const { trusted: _trusted, ...outcome } = await client.askMemory(text, arc);
      return outcome;
    },
    airlock,
  };
}

export function servedAirlock(client: KeyworkClient): ArcAirlockPort {
  return {
    digest: async (slug) => {
      const digest = await client.airlock(slug);
      return digest === undefined ? undefined : digestView(digest);
    },
    triageCandidate: async (slug, note, choice) => {
      await client.triageAirlockCandidate(slug, note, choice);
    },
    triageQuestion: async (slug, title, choice) => {
      await client.triageAirlockQuestion(slug, title, choice);
    },
    deliverEligible: async (slug) => (await client.deliverAirlock(slug)).delivered,
    finish: (slug, options) => client.finishAirlock(slug, options),
  };
}

export function servedMcp(client: KeyworkClient, feed: ServerFeed): McpPanePort {
  return {
    load: async () => (await client.mcpServers()).map(serverView),
    restart: async (name) => {
      await client.restartMcpServer(name);
    },
    setEnabled: async (name, on) => {
      await client.setMcpServerEnabled(name, on);
    },
    listTools: (name) => client.mcpServerTools(name),
    subscribe: (listener) =>
      onSurface(feed, "mcp", () => {
        client.mcpServers().then(
          (servers) => listener(servers.map(serverView)),
          () => {},
        );
      }),
  };
}

export function servedArcs(
  client: KeyworkClient,
  feed: ServerFeed,
  airlock: ArcAirlockPort,
): ArcsPort {
  return {
    list: async () => (await client.arcs()).arcs,
    create: (slug) => client.createArc(slug),
    close: (slug, direction) => client.closeArc(slug, direction),
    abandon: (slug) => client.abandonArc(slug),
    wear: (slug, theme) => client.setArcTheme(slug, theme ?? null),
    subscribe: (listener) => onSurface(feed, "arcs", listener),
    airlock,
  };
}

export function servedBots(client: KeyworkClient, feed: ServerFeed): BotsPort {
  let roster: readonly BotEntry[] = [];
  const list = async () => {
    const bots = await client.bots();
    roster = bots;
    return bots;
  };
  list().catch(() => {});
  onSurface(feed, "bots", () => {
    list().catch(() => {});
  });
  return {
    defined: () => roster,
    list,
    create: async (draft) => {
      const bot = await client.createBot(draft);
      await list();
      return bot;
    },
    subscribe: (changed) => onSurface(feed, "bots", changed),
  };
}

export function servedWorkspaces(client: KeyworkClient): WorkspacesPort {
  return {
    list: () => client.workspaces(),
    create: (slug) => client.createWorkspace(slug),
    use: async () => {
      throw new Error(attachedWorkspaceSwitch);
    },
    linkFocusDir: (slug, dir) => client.focusWorkspaceDir(slug ?? null, dir),
    unlinkFocusDir: (slug, dir) => client.unfocusWorkspaceDir(slug ?? null, dir),
  };
}

export function servedContextReadings(
  client: KeyworkClient,
  feed: ServerFeed,
  session: SessionChoice,
): ContextReadings {
  let anchor: ContextSubject | undefined;
  void anchorSubject(client, session).then((subject) => {
    anchor = subject;
  });
  return {
    fallback: () => anchor,
    read: (sessionId) => client.context(sessionId),
    compact: (sessionId) => client.compact(sessionId),
    subscribe: (listener) =>
      feed.subscribe((envelope) => {
        if (contextMoves.has(envelope.type)) listener(envelope.sessionId);
      }),
  };
}

const contextMoves: ReadonlySet<BusEnvelope["type"]> = new Set([
  "turn.completed",
  "turn.interrupted",
  "session.settled",
  "session.state",
]);

async function anchorSubject(
  client: KeyworkClient,
  session: SessionChoice,
): Promise<ContextSubject | undefined> {
  const sessionId = await session().catch(() => undefined);
  if (sessionId === undefined) return undefined;
  const detail = await client.session(sessionId).catch(() => undefined);
  return { sessionId, name: detail?.title ?? sessionId.slice(0, 8) };
}

const emptyMemory: MemoryPaneInputs = { layers: [], notes: [], inbox: [], ledger: [] };

function servedInputs(overview: MemoryOverview, notes: readonly CuredNote[]): MemoryPaneInputs {
  return {
    layers: [...overview.layers],
    notes: servedNoteViews(notes),
    inbox: overview.inbox.map(inboxView),
    ledger: [...overview.ledger.map(ledgerOpView), ...overview.audit.map(auditView)],
    gardener: {
      state: overview.gardener?.state ?? "idle",
      ...lastSweep(overview.audit),
      ...(overview.gardener?.sweptAt !== undefined && { sweptAt: overview.gardener.sweptAt }),
    },
    airlocks: overview.airlocks.map(digestView),
  };
}

function servedNoteViews(notes: readonly CuredNote[]): MemoryNoteView[] {
  const graphs = new Map<string, MemoryGraph>();
  const graphOf = (layer: string): MemoryGraph => {
    const known = graphs.get(layer);
    if (known !== undefined) return known;
    const graph = MemoryGraph.fromNotes(notes.filter((note) => note.layer === layer));
    graphs.set(layer, graph);
    return graph;
  };
  return notes.map((note) =>
    noteView(
      note,
      {
        layer: note.layer,
        file: note.file,
        curing: note.curing,
        injected: note.injected,
        recalls: note.recalls,
      },
      graphOf(note.layer),
    ),
  );
}

function digestView(digest: ArcCloseDigestRecord | Trusted<AirlockDigest>): AirlockDigestView {
  return {
    arc: digest.arc,
    candidates: digest.candidates,
    questions: digest.questions,
    ...(digest.successor !== undefined && { successor: digest.successor }),
    ...(digest.sweep !== undefined && { sweep: digest.sweep }),
    ...(digest.direction !== undefined && { direction: digest.direction }),
  };
}

function onSurface(feed: ServerFeed, kind: string, listener: () => void): () => void {
  return feed.subscribe((envelope) => {
    if (envelope.type !== "surface.changed") return;
    if ((envelope.payload as { kind?: unknown } | null)?.kind === kind) listener();
  });
}

function workspacePath(path: string): string {
  const flat = path.replaceAll("\\", "/");
  if (flat === "." || flat === "./") return "";
  return flat.startsWith("./") ? flat.slice(2) : flat;
}
