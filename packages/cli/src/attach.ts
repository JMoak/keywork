import {
  type ClientSeams,
  type KeyworkClient,
  keyworkClient,
  resolveServerTicket,
  ServerRefusal,
  type ServerTicket,
} from "@keywork/server";
import { type AppOptions, runApp, type WorkspacePort, type WorkspaceState } from "@keywork/tui";
import { workspaceIdentity } from "./paths.ts";
import { type ServedPanes, servedPanes, servedSpillPath } from "./remote-panes.ts";
import {
  remoteAgentFactory,
  remotePermissionsPort,
  remoteSessionPort,
  remoteSessionTreePort,
  type ServerFeed,
  serverFeed,
} from "./remote-ports.ts";
import { serverTicketFile, ticketFilesFor } from "./serve.ts";

export type AttachablePaneKind =
  | "conversation"
  | "session-tree"
  | "browser"
  | "diff"
  | "memory"
  | "mcp"
  | "arcs"
  | "bots"
  | "workspaces"
  | "permissions"
  | "context";

export type PaneChoice =
  | { kind: "mount"; pane: AttachablePaneKind }
  | { kind: "refused"; reason: string; usage: boolean };

export const attachablePaneKinds: readonly AttachablePaneKind[] = [
  "conversation",
  "session-tree",
  "browser",
  "diff",
  "memory",
  "mcp",
  "arcs",
  "bots",
  "workspaces",
  "permissions",
  "context",
];

export function choosePane(name: string | undefined): PaneChoice {
  if (name === undefined) return { kind: "mount", pane: "conversation" };
  const pane = paneAliases[name] ?? name;
  if (isAttachable(pane)) return { kind: "mount", pane };
  const refusal = refusals[pane];
  if (refusal !== undefined) return { kind: "refused", usage: false, reason: refusal };
  return {
    kind: "refused",
    usage: true,
    reason: `no pane kind named "${name}" · attach mounts ${attachablePaneKinds.join(", ")}`,
  };
}

export interface AttachOptions {
  pane: AttachablePaneKind;
  session?: string | undefined;
  url?: string | undefined;
  token?: string | undefined;
  ticketFile?: string | undefined;
  cwd?: string | undefined;
  workspaceSlug?: string | undefined;
  printError: (line: string) => void;
}

export interface AttachSeams {
  client?: ClientSeams;
  createRenderer?: AppOptions["createRenderer"];
  exit?: (code: number) => void;
}

export async function attach(options: AttachOptions, seams: AttachSeams = {}): Promise<number> {
  const ticketFiles = ticketCandidates(options);
  const found = ticketFiles
    .map((file) => ({
      file,
      ticket: resolveServerTicket({ file, url: options.url, token: options.token }),
    }))
    .find((candidate) => candidate.ticket !== undefined);
  if (found?.ticket === undefined) {
    options.printError(
      `keywork attach: no server ticket at ${ticketFiles.join(" or ")} · run keywork serve first, or pass --url and --token`,
    );
    return 1;
  }
  const client = keyworkClient(found.ticket, seams.client);
  const problem =
    (await reachabilityProblem(client, options.session)) ??
    (await foreignWorkspaceProblem(client, found.file, options));
  if (problem !== undefined) {
    options.printError(`keywork attach: ${problem}`);
    return 1;
  }
  const feed = serverFeed(client);
  await feed.open();
  return mount(client, feed, options, seams);
}

export function ticketCandidates(
  options: Pick<AttachOptions, "ticketFile" | "cwd" | "workspaceSlug">,
): string[] {
  if (options.ticketFile !== undefined) return [options.ticketFile];
  if (options.cwd === undefined) return [serverTicketFile()];
  return ticketFilesFor(options.cwd, options.workspaceSlug);
}

export function attachedLabel(ticket: Pick<ServerTicket, "url">): string {
  return `attached · ${new URL(ticket.url).host}`;
}

export function mountedWorkspace(
  pane: AttachablePaneKind,
  sessionId: string | undefined,
): WorkspacePort {
  const mounted = mountedPane(pane, sessionId);
  const state: WorkspaceState = {
    version: 2,
    layout: { tree: { kind: "leaf", id: mounted.id }, focused: mounted.id },
    panes: [mounted],
    held: [],
  };
  return { load: async () => state, save: () => {}, seal: () => {} };
}

const paneAliases: Readonly<Record<string, AttachablePaneKind>> = {
  tree: "session-tree",
  sessions: "session-tree",
  files: "browser",
  changes: "diff",
  workstreams: "arcs",
  ws: "arcs",
  grants: "permissions",
  "context-map": "context",
};

const refusals: Readonly<Record<string, string>> = {
  file: "the file pane opens on a path · attach --pane browser and enter opens a file",
  arc: "the arc pane opens on a slug · attach --pane arcs and enter opens an arc",
  workstream: "the arc pane opens on a slug · attach --pane arcs and enter opens an arc",
  terminal:
    "the terminal pane runs a shell on this machine, and the server's shell stays with keywork serve",
};

type MountedPane = WorkspaceState["panes"][number];

function mountedPane(pane: AttachablePaneKind, sessionId: string | undefined): MountedPane {
  const session = sessionId === undefined ? {} : { sessionId };
  switch (pane) {
    case "conversation":
      return { id: "session-1", kind: "conversation", ...session };
    case "session-tree":
      return { id: "tree-1", kind: "session-tree", ...session };
    case "browser":
      return { id: "browser-1", kind: "browser", root: "." };
    default:
      return { id: `${pane}-1`, kind: pane };
  }
}

async function reachabilityProblem(
  client: KeyworkClient,
  sessionId: string | undefined,
): Promise<string | undefined> {
  try {
    await client.sessions();
    if (sessionId !== undefined && (await client.session(sessionId)) === undefined) {
      return `the server at ${client.url} has no session ${sessionId}`;
    }
    return undefined;
  } catch (cause) {
    if (cause instanceof ServerRefusal) return `${client.url} answered: ${cause.message}`;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `can't reach ${client.url} · ${detail}`;
  }
}

async function foreignWorkspaceProblem(
  client: KeyworkClient,
  ticketFile: string,
  options: Pick<AttachOptions, "cwd" | "workspaceSlug" | "url">,
): Promise<string | undefined> {
  if (options.cwd === undefined || options.url !== undefined) return undefined;
  if (ticketFile !== serverTicketFile()) return undefined;
  const served = (await client.document().catch(() => undefined))?.info.workspace;
  if (served === undefined) return undefined;
  if (served.identity === workspaceIdentity(options.cwd, options.workspaceSlug)) return undefined;
  return `the server at ${client.url} serves ${served.anchor}, not this workspace · run keywork serve here, or pass --url and --token to attach to it anyway`;
}

function mount(
  client: KeyworkClient,
  feed: ServerFeed,
  options: AttachOptions,
  seams: AttachSeams,
): Promise<number> {
  const anchor = anchorSession(client, options.session);
  const served = servedPanes(client, feed, () => anchor);
  return new Promise<number>((settle, fail) => {
    const exit = (code: number): void => {
      feed.close();
      settle(code);
      seams.exit?.(code);
    };
    runApp({
      sessions: remoteSessionPort(client),
      sessionTrees: remoteSessionTreePort(client, feed),
      agentFactory: remoteAgentFactory(client, feed),
      permissions: remotePermissionsPort(client),
      ...servedOptions(served),
      workspace: mountedWorkspace(options.pane, options.session),
      statusLabel: attachedLabel(client),
      notices: {
        subscribe: (post) => {
          post(`${attachedLabel(client)} · the server answers asks with no`);
          return feed.whenLost((reason) => post(`lost the server · ${reason.message}`));
        },
      },
      exit,
      ...(seams.createRenderer !== undefined && { createRenderer: seams.createRenderer }),
    }).catch(fail);
  });
}

function servedOptions(served: ServedPanes): AppOptions {
  return {
    files: served.files,
    diff: served.diff,
    memory: served.memory,
    mcp: served.mcp,
    arcs: served.arcs,
    bots: served.bots,
    workspaces: served.workspaces,
    contextReadings: served.contextReadings,
    spillFile: servedSpillPath,
  };
}

async function anchorSession(
  client: KeyworkClient,
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (sessionId !== undefined) return sessionId;
  const rows = await client.sessions().catch(() => []);
  const newest = [...rows].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt),
  )[0];
  return newest?.id;
}

function isAttachable(name: string): name is AttachablePaneKind {
  return (attachablePaneKinds as readonly string[]).includes(name);
}
