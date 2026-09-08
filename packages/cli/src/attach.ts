import {
  type ClientSeams,
  type KeyworkClient,
  keyworkClient,
  resolveServerTicket,
  ServerRefusal,
  type ServerTicket,
} from "@keywork/server";
import { type AppOptions, runApp, type WorkspacePort, type WorkspaceState } from "@keywork/tui";
import {
  remoteAgentFactory,
  remoteSessionPort,
  remoteSessionTreePort,
  type ServerFeed,
  serverFeed,
} from "./remote-ports.ts";
import { serverTicketFile, ticketFilesFor } from "./serve.ts";

export type AttachablePaneKind = "conversation" | "session-tree";

export type PaneChoice =
  | { kind: "mount"; pane: AttachablePaneKind }
  | { kind: "refused"; reason: string; usage: boolean };

export const attachablePaneKinds: readonly AttachablePaneKind[] = ["conversation", "session-tree"];

const localFilePanes: ReadonlySet<string> = new Set(["browser", "file", "diff", "terminal"]);
const localWorkspacePanes: ReadonlySet<string> = new Set([
  "memory",
  "mcp",
  "arcs",
  "arc",
  "workspaces",
]);

export function choosePane(name: string | undefined): PaneChoice {
  if (name === undefined) return { kind: "mount", pane: "conversation" };
  if (isAttachable(name)) return { kind: "mount", pane: name };
  if (localFilePanes.has(name)) {
    return {
      kind: "refused",
      usage: false,
      reason: `the ${name} pane reads local files, and an attached client has none`,
    };
  }
  if (localWorkspacePanes.has(name)) {
    return {
      kind: "refused",
      usage: false,
      reason: `the ${name} pane needs the local workspace, which stays with keywork serve`,
    };
  }
  return {
    kind: "refused",
    usage: true,
    reason: `no pane kind named "${name}" · attach mounts ${attachablePaneKinds.join(" or ")}`,
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
  const ticket = ticketFiles
    .map((file) => resolveServerTicket({ file, url: options.url, token: options.token }))
    .find((candidate) => candidate !== undefined);
  if (ticket === undefined) {
    options.printError(
      `keywork attach: no server ticket at ${ticketFiles.join(" or ")} · run keywork serve first, or pass --url and --token`,
    );
    return 1;
  }
  const client = keyworkClient(ticket, seams.client);
  const problem = await reachabilityProblem(client, options.session);
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
  const id = pane === "conversation" ? "session-1" : "tree-1";
  const state: WorkspaceState = {
    version: 2,
    layout: { tree: { kind: "leaf", id }, focused: id },
    panes: [{ id, kind: pane, ...(sessionId !== undefined && { sessionId }) }],
    held: [],
  };
  return { load: async () => state, save: () => {}, seal: () => {} };
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

function mount(
  client: KeyworkClient,
  feed: ServerFeed,
  options: AttachOptions,
  seams: AttachSeams,
): Promise<number> {
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

function isAttachable(name: string): name is AttachablePaneKind {
  return (attachablePaneKinds as readonly string[]).includes(name);
}
