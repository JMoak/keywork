import type { CommandRegistry } from "./commands.ts";
import type { DockSide } from "./layout.ts";
import type { FileOpenOptions, MemoryLens, Pane, PaneDescriptor, PaneIntents } from "./pane.ts";

export type PaneKind = PaneDescriptor["kind"];
export type PaneHome = "main" | DockSide;
export type SummonableKind = "browser" | "session-tree" | "arcs" | "workspaces" | "memory" | "mcp";

export type ArcOrigin = "inherit" | "new";

export interface PaneOrigin {
  sourcePaneId?: string;
  arc: ArcOrigin;
}

export type PaneFactory = (
  id: string,
  notify: () => void,
  commands: CommandRegistry,
  resumeSessionId?: string,
  draft?: string,
  origin?: PaneOrigin,
) => Pane | undefined;
export type FilePaneFactory = (
  id: string,
  path: string,
  notify: () => void,
  options?: FileOpenOptions,
) => Pane;
export type BrowserPaneFactory = (
  id: string,
  root: string,
  notify: () => void,
  intents: PaneIntents,
) => Pane;
export type SessionTreePaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  sessionId?: string,
) => Pane;
export type ArcsPaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  arc?: string,
) => Pane;
export type ArcPaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  arc: string,
) => Pane;
export interface MemoryPaneRevival {
  lens?: MemoryLens;
  note?: string;
  query?: string;
}
export type MemoryPaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  revival?: MemoryPaneRevival,
) => Pane;
export type McpPaneFactory = (id: string, notify: () => void) => Pane;
export type WorkspacesPaneFactory = (id: string, notify: () => void, intents: PaneIntents) => Pane;

export interface PaneFactories {
  createPane: PaneFactory;
  createFilePane?: FilePaneFactory;
  createBrowserPane?: BrowserPaneFactory;
  createSessionTreePane?: SessionTreePaneFactory;
  createArcsPane?: ArcsPaneFactory;
  createArcPane?: ArcPaneFactory;
  createMemoryPane?: MemoryPaneFactory;
  createMcpPane?: McpPaneFactory;
  createWorkspacesPane?: WorkspacesPaneFactory;
}

export type PaneRequest =
  | { kind: "conversation"; sessionId?: string; draft?: string; origin?: PaneOrigin }
  | { kind: "file"; path: string; options?: FileOpenOptions }
  | { kind: "browser"; root: string }
  | { kind: "session-tree"; sessionId?: string }
  | { kind: "arcs"; arc?: string }
  | { kind: "arc"; arc: string }
  | ({ kind: "memory" } & MemoryPaneRevival)
  | { kind: "mcp" }
  | { kind: "workspaces" };

export interface PaneKindSpec {
  readonly idPrefix: string;
  readonly home: PaneHome;
  readonly factory: keyof PaneFactories;
  readonly dockWeight?: number;
}

export const paneKinds: Readonly<Record<PaneKind, PaneKindSpec>> = {
  conversation: { idPrefix: "session", home: "main", factory: "createPane" },
  file: { idPrefix: "file", home: "main", factory: "createFilePane" },
  browser: { idPrefix: "browser", home: "left", factory: "createBrowserPane" },
  "session-tree": { idPrefix: "tree", home: "left", factory: "createSessionTreePane" },
  arcs: { idPrefix: "arcs", home: "left", factory: "createArcsPane" },
  arc: { idPrefix: "arc", home: "right", factory: "createArcPane", dockWeight: 0.5 },
  memory: { idPrefix: "memory", home: "left", factory: "createMemoryPane" },
  mcp: { idPrefix: "mcp", home: "right", factory: "createMcpPane" },
  workspaces: { idPrefix: "workspaces", home: "left", factory: "createWorkspacesPane" },
};

export function dockWeightOf(id: string): number {
  const kind = paneKindOf(id);
  return kind === undefined ? 1 : (paneKinds[kind].dockWeight ?? 1);
}

export const summonRequests: Readonly<Record<SummonableKind, PaneRequest>> = {
  browser: { kind: "browser", root: "." },
  "session-tree": { kind: "session-tree" },
  arcs: { kind: "arcs" },
  workspaces: { kind: "workspaces" },
  memory: { kind: "memory" },
  mcp: { kind: "mcp" },
};

export interface PaneBuildSeams {
  notifierFor(id: string): () => void;
  commands: CommandRegistry;
  intents: PaneIntents;
  conversationSession(): string | undefined;
}

export function paneKindAvailable(factories: PaneFactories, kind: PaneKind): boolean {
  return factories[paneKinds[kind].factory] !== undefined;
}

export function paneKindOf(id: string): PaneKind | undefined {
  const prefix = id.slice(0, id.lastIndexOf("-"));
  return kindsByPrefix.get(prefix);
}

export function buildPane(
  factories: PaneFactories,
  seams: PaneBuildSeams,
  id: string,
  request: PaneRequest,
): Pane | undefined {
  const notify = seams.notifierFor(id);
  switch (request.kind) {
    case "conversation":
      return factories.createPane(
        id,
        notify,
        seams.commands,
        request.sessionId,
        request.draft,
        request.origin,
      );
    case "file":
      return factories.createFilePane?.(id, request.path, notify, request.options);
    case "browser":
      return factories.createBrowserPane?.(id, request.root, notify, seams.intents);
    case "session-tree":
      return factories.createSessionTreePane?.(
        id,
        notify,
        seams.intents,
        seams.conversationSession,
        request.sessionId,
      );
    case "arcs":
      return factories.createArcsPane?.(
        id,
        notify,
        seams.intents,
        seams.conversationSession,
        request.arc,
      );
    case "arc":
      return factories.createArcPane?.(
        id,
        notify,
        seams.intents,
        seams.conversationSession,
        request.arc,
      );
    case "memory":
      return factories.createMemoryPane?.(id, notify, seams.intents, seams.conversationSession, {
        ...(request.lens !== undefined && { lens: request.lens }),
        ...(request.note !== undefined && { note: request.note }),
        ...(request.query !== undefined && { query: request.query }),
      });
    case "mcp":
      return factories.createMcpPane?.(id, notify);
    case "workspaces":
      return factories.createWorkspacesPane?.(id, notify, seams.intents);
  }
}

export class PaneIds {
  private readonly next = new Map<PaneKind, number>();

  mint(kind: PaneKind): string {
    return `${paneKinds[kind].idPrefix}-${this.next.get(kind) ?? 1}`;
  }

  adopt(id: string): void {
    const kind = paneKindOf(id);
    const ordinal = Number(id.slice(id.lastIndexOf("-") + 1));
    if (kind === undefined || !Number.isInteger(ordinal)) return;
    this.next.set(kind, Math.max(this.next.get(kind) ?? 1, ordinal + 1));
  }
}

const kindsByPrefix: ReadonlyMap<string, PaneKind> = new Map(
  (Object.entries(paneKinds) as Array<[PaneKind, PaneKindSpec]>).map(([kind, spec]) => [
    spec.idPrefix,
    kind,
  ]),
);
