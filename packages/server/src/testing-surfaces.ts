import type { McpServerStatus } from "@keywork/engine";
import { type CompleteTheme, slugProblem, type TrustDecision } from "@keywork/shared";
import type { EventLog, SurfaceKind } from "./events.ts";
import {
  type ArcSummary,
  type BotEntry,
  type FileSlice,
  HostRefusal,
  maxFileBytes,
  type SurfaceHost,
  sliceBounds,
  type TreeEntry,
  type WorkspaceChoice,
  type WorkspaceHost,
  type WorkspaceView,
} from "./host.ts";

export interface MemorySurfaceOptions {
  log: EventLog;
  root?: string;
  trust?: TrustDecision;
  declared?: boolean;
  files?: Readonly<Record<string, string>>;
  ignored?: readonly string[];
  mcp?: readonly McpServerStatus[];
  mcpTools?: Readonly<Record<string, readonly string[]>>;
  arcs?: readonly ArcSummary[];
  bots?: readonly BotEntry[];
  workspaces?: readonly WorkspaceChoice[];
  themes?: readonly CompleteTheme[];
  now?: () => Date;
}

export type SessionStatus = "missing" | "busy" | "idle";

export interface SessionBindings {
  arc?: string | undefined;
  bot?: string | undefined;
}

export interface MemorySurfaces {
  host: WorkspaceHost & SurfaceHost;
  bindingsOf(sessionId: string): SessionBindings;
  remembered(): string | null | undefined;
}

export const arcsUnavailable = "arcs need a trusted workspace with memory · /init sets one up";

export function memorySurfaces(
  options: MemorySurfaceOptions,
  sessionStatus: (id: string) => SessionStatus,
): MemorySurfaces {
  const state = new SurfaceState(options);
  const changed = (kind: SurfaceKind): void => {
    options.log.announce("surface.changed", { kind });
  };
  const host: WorkspaceHost & SurfaceHost = {
    workspace: async () => state.workspaceView(),
    tree: async (path) => ({ path: state.directoryOf(path), entries: state.listing(path) }),
    readFile: async (path, range) => state.slice(path, range),
    trustWorkspace: async () => {
      const root = state.root;
      switch (state.trust) {
        case "trusted":
          return { trusted: true, root, reopens: false };
        case "untrusted":
          throw new HostRefusal(
            409,
            `${root} is marked untrusted, so keywork won't write a workspace there · keywork trust reverses that`,
          );
        case "undecided":
          state.trust = "trusted";
          changed("workspace");
          return { trusted: true, root, reopens: true };
      }
    },
    themes: async () => ({
      themes: state.themes,
      active: "keywork-night",
      placeholders: ["system"],
    }),
    mcpServers: async () => state.mcp.map((server) => ({ ...server })),
    restartMcpServer: async (name) => {
      const server = state.mcpServer(name);
      server.state = "connected";
      server.enabled = true;
      server.toolCount = state.toolsOf(name).length;
      delete server.lastError;
      changed("mcp");
      return { ...server };
    },
    setMcpServerEnabled: async (name, enabled) => {
      const server = state.mcpServer(name);
      server.enabled = enabled;
      server.state = enabled ? "connected" : "down";
      server.toolCount = enabled ? state.toolsOf(name).length : 0;
      changed("mcp");
      return { ...server };
    },
    mcpServerTools: async (name) => (state.mcpServer(name).enabled ? state.toolsOf(name) : []),
    arcs: async () => {
      state.requireArcs();
      return { arcs: state.arcSummaries(), ordinals: state.arcOrdinals() };
    },
    createArc: async (requested) => {
      state.requireArcs();
      const slug = requested ?? state.nextArcSlug();
      const problem = slugProblem(slug);
      if (problem !== undefined)
        throw new HostRefusal(400, `invalid arc slug "${slug}": ${problem}`);
      if (state.arc(slug) !== undefined) {
        throw new HostRefusal(409, `an arc named "${slug}" already exists`);
      }
      const arc: ArcSummary = { slug, status: "active", created: state.now(), sessions: 0 };
      state.arcs.push(arc);
      changed("arcs");
      return { ...arc };
    },
    closeArc: async (slug) => {
      const released = state.archive(slug);
      changed("arcs");
      return { kind: "closed", delivered: 0, released };
    },
    abandonArc: async (slug) => {
      state.archive(slug);
      changed("arcs");
    },
    bindArc: async (sessionId, slug) => {
      if (sessionStatus(sessionId) === "missing") return "missing";
      state.requireArcs();
      if (slug !== null) state.activeArc(slug);
      state.bind(sessionId, { arc: slug ?? undefined });
      changed("arcs");
      return "bound";
    },
    bots: async () =>
      state.bots.map((bot) => ({ ...bot, sessions: state.sessionsBoundTo("bot", bot.name) })),
    createBot: async (draft) => {
      const problem = slugProblem(draft.slug);
      if (problem !== undefined) {
        throw new HostRefusal(400, `invalid bot slug "${draft.slug}": ${problem}`);
      }
      if (draft.scope === "project" && state.trust !== "trusted") {
        throw new HostRefusal(
          403,
          "project bots need a trusted workspace · keywork trust, or make it global",
        );
      }
      const existing = state.bots.find((bot) => bot.name === draft.slug);
      if (existing !== undefined) {
        throw new HostRefusal(409, `a bot named ${draft.slug} already exists (${existing.source})`);
      }
      const bot: BotEntry = {
        name: draft.slug,
        sigil: draft.slug.slice(0, 1).toUpperCase(),
        source: draft.scope,
        learning: "notes",
        ...(draft.purpose !== undefined && { description: draft.purpose }),
      };
      state.bots.push(bot);
      changed("bots");
      return { ...bot };
    },
    switchBot: async (sessionId, name) => {
      const status = sessionStatus(sessionId);
      if (status !== "idle") return status;
      if (name !== null && state.bots.every((bot) => bot.name !== name)) {
        throw new HostRefusal(404, `no bot named ${name}`);
      }
      state.bind(sessionId, { bot: name ?? undefined });
      changed("bots");
      return "switched";
    },
    workspaces: async () => state.workspaces.map((choice) => ({ ...choice })),
    createWorkspace: async (slug) => {
      const problem = slugProblem(slug);
      if (problem !== undefined) {
        throw new HostRefusal(400, `"${slug}" isn't a workspace slug · ${problem}`);
      }
      if (state.workspace(slug) !== undefined) {
        throw new HostRefusal(409, `a workspace named ${slug} already exists`);
      }
      state.workspaces.push({
        slug,
        name: slug.split("-").filter(Boolean).join(" "),
        declared: true,
        current: false,
        notes: 0,
        focusDirs: [],
        sessions: 0,
        lastUsed: undefined,
      });
      changed("workspaces");
    },
    useWorkspace: async (slug) => {
      if (slug !== null && state.workspace(slug) === undefined) {
        throw new HostRefusal(
          404,
          `no workspace named ${slug} · /workspace new ${slug} creates it`,
        );
      }
      state.rememberedSlug = slug;
      changed("workspaces");
    },
    focusWorkspace: async (slug, dir) => {
      const workspace = state.declaredWorkspace(slug);
      if (workspace.focusDirs.includes(dir)) {
        throw new HostRefusal(400, `${dir} is already a focus dir`);
      }
      workspace.focusDirs = [...workspace.focusDirs, dir];
      changed("workspaces");
      return dir;
    },
    unfocusWorkspace: async (slug, dir) => {
      const workspace = state.declaredWorkspace(slug);
      if (!workspace.focusDirs.includes(dir)) {
        throw new HostRefusal(400, `${dir} isn't a focus dir here`);
      }
      workspace.focusDirs = workspace.focusDirs.filter((focus) => focus !== dir);
      changed("workspaces");
    },
  };
  return {
    host,
    bindingsOf: (sessionId) => state.bindings.get(sessionId) ?? {},
    remembered: () => state.rememberedSlug,
  };
}

class SurfaceState {
  readonly root: string;
  trust: TrustDecision;
  readonly declared: boolean;
  readonly files: Readonly<Record<string, string>>;
  readonly ignored: readonly string[];
  readonly mcp: McpServerStatus[];
  readonly mcpTools: Readonly<Record<string, readonly string[]>>;
  readonly arcs: ArcSummary[];
  readonly bots: BotEntry[];
  readonly workspaces: WorkspaceChoice[];
  readonly themes: readonly CompleteTheme[];
  readonly bindings = new Map<string, SessionBindings>();
  readonly now: () => string;
  rememberedSlug: string | null | undefined;

  constructor(options: MemorySurfaceOptions) {
    this.root = options.root ?? "/memory";
    this.trust = options.trust ?? "undecided";
    this.declared = options.declared ?? false;
    this.files = options.files ?? {};
    this.ignored = options.ignored ?? [];
    this.mcp = (options.mcp ?? []).map((server) => ({ ...server }));
    this.mcpTools = options.mcpTools ?? {};
    this.arcs = (options.arcs ?? []).map((arc) => ({ ...arc }));
    this.bots = (options.bots ?? []).map((bot) => ({ ...bot }));
    this.workspaces = (options.workspaces ?? []).map((choice) => ({ ...choice }));
    this.themes = options.themes ?? [];
    const clock = options.now ?? (() => new Date());
    this.now = () => clock().toISOString();
  }

  workspaceView(): WorkspaceView {
    return {
      anchor: { root: this.root, source: "launch" },
      identity: "memory",
      declared: this.declared,
      contextDirs: [],
      missingContextDirs: [],
      focusDirs: [],
      trust: this.trust,
      readiness: this.readiness(),
    };
  }

  readiness(): WorkspaceView["readiness"] {
    switch (this.trust) {
      case "untrusted":
        return "refused";
      case "undecided":
        return "undecided";
      case "trusted":
        return this.declared ? "ready" : "undeclared";
    }
  }

  directoryOf(path: string): string {
    const directory = this.confined(path);
    if (directory !== "" && !this.isDirectory(directory)) {
      throw new HostRefusal(404, `no directory at ${path}`);
    }
    return directory;
  }

  listing(path: string): TreeEntry[] {
    const directory = this.directoryOf(path);
    const prefix = directory === "" ? "" : `${directory}/`;
    const names = new Map<string, TreeEntry["kind"]>();
    for (const key of Object.keys(this.files)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [name = "", ...deeper] = rest.split("/");
      if (name === "") continue;
      names.set(name, deeper.length > 0 ? "dir" : (names.get(name) ?? "file"));
    }
    return [...names]
      .map(([name, kind]) => ({
        name,
        kind,
        ignored: this.ignored.includes(`${prefix}${name}`),
        hidden: name.startsWith("."),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  slice(path: string, range: { from?: number; to?: number }): FileSlice {
    const relative = this.confined(path);
    const text = this.files[relative];
    if (text === undefined) throw new HostRefusal(404, `no file at ${path}`);
    const whole = Buffer.from(text, "utf8");
    if (whole.length > maxFileBytes) throw new HostRefusal(413, "file too large");
    const bounds = sliceBounds(whole.length, range);
    const bytes = whole.subarray(bounds.from, bounds.to);
    if (bytes.includes(0)) throw new HostRefusal(415, "binary file");
    return { path: relative, ...bounds, text: bytes.toString("utf8"), encoding: "utf-8" };
  }

  mcpServer(name: string): McpServerStatus {
    const server = this.mcp.find((candidate) => candidate.name === name);
    if (server === undefined) throw new HostRefusal(404, `unknown MCP server: ${name}`);
    return server;
  }

  toolsOf(name: string): readonly string[] {
    return this.mcpTools[name] ?? [];
  }

  requireArcs(): void {
    if (this.readiness() !== "ready") throw new HostRefusal(403, arcsUnavailable);
  }

  arc(slug: string): ArcSummary | undefined {
    return this.arcs.find((arc) => arc.slug === slug);
  }

  activeArc(slug: string): ArcSummary {
    const arc = this.arc(slug);
    if (arc === undefined) throw new HostRefusal(404, `no arc named "${slug}"`);
    if (arc.status !== "active") {
      throw new HostRefusal(409, `arc "${slug}" is ${arc.status}, not active`);
    }
    return arc;
  }

  archive(slug: string): number {
    this.requireArcs();
    const arc = this.activeArc(slug);
    arc.status = "archived";
    let released = 0;
    for (const [sessionId, bound] of this.bindings) {
      if (bound.arc !== slug) continue;
      this.bindings.set(sessionId, { ...bound, arc: undefined });
      released += 1;
    }
    return released;
  }

  arcSummaries(): ArcSummary[] {
    return this.arcs.map((arc) => ({ ...arc, sessions: this.sessionsBoundTo("arc", arc.slug) }));
  }

  arcOrdinals(): Record<string, number> {
    const ordered = [...this.arcs].sort(
      (left, right) =>
        left.created.localeCompare(right.created) || left.slug.localeCompare(right.slug),
    );
    return Object.fromEntries(ordered.map((arc, ordinal) => [arc.slug, ordinal]));
  }

  nextArcSlug(): string {
    const taken = new Set(this.arcs.map((arc) => arc.slug));
    for (let ordinal = this.arcs.length + 1; ; ordinal += 1) {
      const candidate = `arc-${ordinal}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  bind(sessionId: string, change: SessionBindings): void {
    this.bindings.set(sessionId, { ...this.bindings.get(sessionId), ...change });
  }

  sessionsBoundTo(kind: keyof SessionBindings, name: string): number {
    return [...this.bindings.values()].filter((bound) => bound[kind] === name).length;
  }

  workspace(slug: string | null): WorkspaceChoice | undefined {
    return this.workspaces.find((choice) => choice.slug === (slug ?? undefined));
  }

  declaredWorkspace(slug: string | null): WorkspaceChoice {
    const workspace = this.workspace(slug);
    if (workspace === undefined) {
      throw new HostRefusal(
        404,
        slug === null
          ? "this workspace isn't set up yet · /init declares it"
          : `no workspace named ${slug} here`,
      );
    }
    return workspace;
  }

  private confined(path: string): string {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\/|\/$/g, "");
    const segments = normalized === "" ? [] : normalized.split("/");
    const escapes = /^([A-Za-z]:|\/)/.test(normalized) || segments.includes("..");
    if (escapes) {
      throw new HostRefusal(
        403,
        `${path} escapes the project root; tools may only touch files inside it`,
      );
    }
    return segments.filter((segment) => segment !== "." && segment !== "").join("/");
  }

  private isDirectory(directory: string): boolean {
    return Object.keys(this.files).some((key) => key.startsWith(`${directory}/`));
  }
}
