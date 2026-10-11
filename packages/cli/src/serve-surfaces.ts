import {
  ArcExistsError,
  ArcNotActiveError,
  type BotDefinition,
  type McpRegistry,
  McpRegistryClosedError,
  McpServerNotFoundError,
  type McpServerStatus,
  MissingArcError,
  MissingSuccessorError,
} from "@keywork/engine";
import {
  type ArcsView,
  type BindOutcome,
  type EventLog,
  HostRefusal,
  type SurfaceHost,
  type SwitchBotOutcome,
} from "@keywork/server";
import { InvalidSlugError, openWorkspace, slugProblem, type TrustStore } from "@keywork/shared";
import {
  type ArcsPort,
  arcOrdinalsOf,
  arcSlugProblem,
  type BotsPort,
  readinessNotice,
  suggestArcSlug,
  type WorkspacesPort,
} from "@keywork/tui";
import type { AnchorMemory } from "./anchor.ts";
import type { ArcService } from "./arcs.ts";
import { arcsUnavailable } from "./arcs.ts";
import { workspaceReadiness } from "./workspace-setup.ts";
import { type WorkspaceRecall, workspacesPort } from "./workspaces.ts";

export interface SurfaceComposition {
  mcp: McpRegistry | undefined;
  arcs: ArcService;
  bots: BotsPort;
  roster: readonly BotDefinition[];
}

export interface SurfaceSessions {
  bindArc(sessionId: string, slug: string | undefined): Promise<BindOutcome>;
  switchBot(sessionId: string, bot: BotDefinition | undefined): Promise<SwitchBotOutcome>;
}

export interface SurfaceHostOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug: string | undefined;
  sessionDir: string;
  trustStore: TrustStore;
  anchorMemory: AnchorMemory;
  workspaceRecall: WorkspaceRecall;
  sessionDirFor(slug: string | undefined): string;
  log: EventLog;
  composed(): Promise<SurfaceComposition>;
  sessions: SurfaceSessions;
}

export function surfaceHost(options: SurfaceHostOptions): SurfaceHost {
  const { cwd, projectTrusted, workspaceSlug, log } = options;
  const registry = async (name: string): Promise<McpRegistry> => {
    const { mcp } = await options.composed();
    if (mcp === undefined) throw new HostRefusal(404, new McpServerNotFoundError(name).message);
    return mcp;
  };
  const arcs = async (): Promise<ArcsPort> => {
    const { arcs } = await options.composed();
    if (arcs.registry() === undefined) throw new HostRefusal(403, arcsUnavailableHere(options));
    return arcs.port;
  };
  const workspaces: WorkspacesPort = workspacesPort({
    cwd,
    current: workspaceSlug,
    recall: options.workspaceRecall,
    requestSwitch: () => undefined,
    sessionDirFor: options.sessionDirFor,
  });
  const requireDeclared = (slug: string | null): void => {
    if (openWorkspace(cwd, slug ?? undefined) !== undefined) return;
    throw new HostRefusal(
      404,
      slug === null
        ? "this workspace isn't set up yet · /init declares it"
        : `no workspace named ${slug} here`,
    );
  };
  return {
    mcpServers: async () => (await options.composed()).mcp?.status() ?? [],
    restartMcpServer: async (name) => {
      const mcp = await registry(name);
      await refusing(() => mcp.restart(name));
      return statusOf(mcp, name);
    },
    setMcpServerEnabled: async (name, enabled) => {
      const mcp = await registry(name);
      await refusing(() => (enabled ? mcp.enable(name) : mcp.disable(name)));
      return statusOf(mcp, name);
    },
    mcpServerTools: async (name) => {
      const mcp = await registry(name);
      return refusing(async () => mcp.listTools(name).map((tool) => tool.name));
    },
    arcs: async () => arcsView(await arcs()),
    createArc: async (requested) => {
      const port = await arcs();
      const taken = (await port.list()).map((arc) => arc.slug);
      const slug = requested ?? suggestArcSlug(undefined, taken);
      const problem = arcSlugProblem(slug);
      if (problem !== undefined) throw new HostRefusal(400, problem);
      return refusing(() => port.create(slug));
    },
    closeArc: async (slug, direction) => {
      const port = await arcs();
      return refusing(() => port.close(slug, direction));
    },
    abandonArc: async (slug) => {
      const port = await arcs();
      await refusing(() => port.abandon(slug));
    },
    bindArc: async (sessionId, slug) => {
      const { arcs: service } = await options.composed();
      const found = service.registry();
      if (found === undefined) throw new HostRefusal(403, arcsUnavailableHere(options));
      if (slug !== null) {
        const record = await found.readArc(slug);
        if (record === undefined) throw new HostRefusal(404, new MissingArcError(slug).message);
        if (record.status !== "active") {
          throw new HostRefusal(409, new ArcNotActiveError(slug, record.status).message);
        }
      }
      return options.sessions.bindArc(sessionId, slug ?? undefined);
    },
    bots: async () => (await options.composed()).bots.list(),
    createBot: async (draft) => {
      const { bots, roster } = await options.composed();
      const problem = slugProblem(draft.slug);
      if (problem !== undefined) {
        throw new HostRefusal(400, new InvalidSlugError("bot", draft.slug, problem).message);
      }
      if (draft.scope === "project" && !projectTrusted) {
        throw new HostRefusal(
          403,
          "project bots need a trusted workspace · keywork trust, or make it global",
        );
      }
      const existing = roster.find((bot) => bot.name === draft.slug);
      if (existing !== undefined) {
        throw new HostRefusal(409, `a bot named ${draft.slug} already exists (${existing.source})`);
      }
      const created = await refusing(() => bots.create(draft));
      log.announce("surface.changed", { kind: "bots" });
      return created;
    },
    switchBot: async (sessionId, name) => {
      const { roster } = await options.composed();
      const bot = name === null ? undefined : roster.find((candidate) => candidate.name === name);
      if (name !== null && bot === undefined) throw new HostRefusal(404, `no bot named ${name}`);
      const outcome = await options.sessions.switchBot(sessionId, bot);
      if (outcome === "switched") log.announce("surface.changed", { kind: "bots" });
      return outcome;
    },
    workspaces: () => workspaces.list(),
    createWorkspace: async (slug) => {
      const problem = slugProblem(slug);
      if (problem !== undefined) {
        throw new HostRefusal(400, `"${slug}" isn't a workspace slug · ${problem}`);
      }
      if (openWorkspace(cwd, slug) !== undefined) {
        throw new HostRefusal(409, `a workspace named ${slug} already exists here`);
      }
      await refusing(() => workspaces.create(slug));
      log.announce("surface.changed", { kind: "workspaces" });
    },
    useWorkspace: async (slug) => {
      if (slug !== null) requireDeclared(slug);
      await refusing(() => workspaces.use(slug ?? undefined));
      log.announce("surface.changed", { kind: "workspaces" });
    },
    focusWorkspace: async (slug, dir) => {
      requireDeclared(slug);
      const focused = await refusing(() => workspaces.linkFocusDir(slug ?? undefined, dir));
      log.announce("surface.changed", { kind: "workspaces" });
      return focused;
    },
    unfocusWorkspace: async (slug, dir) => {
      requireDeclared(slug);
      await refusing(() => workspaces.unlinkFocusDir(slug ?? undefined, dir));
      log.announce("surface.changed", { kind: "workspaces" });
    },
  };
}

export function watchSurfaces(composition: SurfaceComposition, log: EventLog): () => void {
  const stops = [
    composition.mcp?.subscribe(() => log.announce("surface.changed", { kind: "mcp" })),
    composition.arcs.port.subscribe?.(() => log.announce("surface.changed", { kind: "arcs" })),
  ];
  return () => {
    for (const stop of stops) stop?.();
  };
}

async function arcsView(port: ArcsPort): Promise<ArcsView> {
  const arcs = await port.list();
  const ordinalOf = arcOrdinalsOf(arcs);
  return {
    arcs,
    ordinals: Object.fromEntries(arcs.map((arc) => [arc.slug, ordinalOf(arc.slug) ?? 0])),
  };
}

function arcsUnavailableHere(
  options: Pick<SurfaceHostOptions, "cwd" | "workspaceSlug" | "trustStore" | "anchorMemory">,
): string {
  const readiness = workspaceReadiness(options, options.anchorMemory);
  return readinessNotice(readiness) ?? arcsUnavailable;
}

function statusOf(registry: McpRegistry, name: string): McpServerStatus {
  const status = registry.status().find((server) => server.name === name);
  if (status === undefined) throw new HostRefusal(404, new McpServerNotFoundError(name).message);
  return status;
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw refusalOf(cause);
  }
}

function refusalOf(cause: unknown): unknown {
  if (cause instanceof HostRefusal) return cause;
  if (cause instanceof InvalidSlugError) return new HostRefusal(400, cause.message);
  if (cause instanceof ArcExistsError) return new HostRefusal(409, cause.message);
  if (cause instanceof MissingArcError) return new HostRefusal(404, cause.message);
  if (cause instanceof ArcNotActiveError) return new HostRefusal(409, cause.message);
  if (cause instanceof MissingSuccessorError) return new HostRefusal(409, cause.message);
  if (cause instanceof McpServerNotFoundError) return new HostRefusal(404, cause.message);
  if (cause instanceof McpRegistryClosedError) return new HostRefusal(409, cause.message);
  if (cause instanceof Error) return new HostRefusal(400, cause.message);
  return cause;
}
