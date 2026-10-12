import { homedir } from "node:os";
import { type McpRegistry, McpServerNotFoundError, type SessionStore } from "@keywork/engine";
import {
  type ArcsPort,
  type BotsPort,
  type McpPort,
  SessionBusyError,
  SurfaceUnavailableError,
  type ThemesPort,
  TrustRefusedError,
  type WorkspacePort,
  type WorkspaceReport,
  type WorkspacesPort,
  workspaceFiles,
} from "@keywork/server";
import { completeTheme, openWorkspace, resolveAnchor, TrustStore, wardrobe } from "@keywork/shared";
import { type BotsPort as BotRoster, keyworkNightTheme, systemThemeName } from "@keywork/tui";
import { anchorMemoryFile, fileAnchorMemory } from "./anchor.ts";
import { type ArcService, arcService, arcsUnavailable } from "./arcs.ts";
import { botService } from "./bots.ts";
import type { Composition } from "./compose.ts";
import { defaultSessionDir, keyworkHome, workspaceIdentity } from "./paths.ts";
import { boundSessionCounts } from "./sessions/ports.ts";
import { workspaceReadiness, workspaceSetupPort } from "./workspace-setup.ts";
import { fileWorkspaceRecall, workspaceRecallFile, workspacesPort } from "./workspaces.ts";

export interface ServedSession {
  store: SessionStore;
  busy(): boolean;
  adoptBinding?(): Promise<void>;
}

export interface SurfacePortsOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
  sessionDir?: string | undefined;
  theme?: string | undefined;
  composition(): Promise<Composition>;
  session(id: string): Promise<ServedSession | undefined>;
  arcs?: ArcService | undefined;
}

export interface SurfacePorts {
  workspace: WorkspacePort;
  mcp: McpPort;
  arcs: ArcsPort;
  bots: BotsPort;
  workspaces: WorkspacesPort;
  themes: ThemesPort;
}

export const projectBotsNeedTrust =
  "project bots need a trusted workspace · keywork trust, or make it global";

export function servedArcService(
  options: Pick<SurfacePortsOptions, "cwd" | "projectTrusted" | "workspaceSlug"> & {
    sessionDir: string;
  },
  composition: Composition,
): ArcService {
  return arcService({
    cwd: options.cwd,
    trusted: options.projectTrusted,
    workspaceSlug: options.workspaceSlug,
    memory: composition.memory,
    boundSessionCounts: () => boundSessionCounts(options.sessionDir),
  });
}

export function surfacePorts(options: SurfacePortsOptions): SurfacePorts {
  const { cwd, projectTrusted, workspaceSlug } = options;
  const userRoot = options.userRoot ?? homedir();
  const sessionDir = options.sessionDir ?? defaultSessionDir(cwd, workspaceSlug);
  const trustStore = new TrustStore({ home: userRoot });
  const anchors = fileAnchorMemory(anchorMemoryFile(userRoot));
  const composed = lazily(async () => {
    const composition = await options.composition();
    return {
      composition,
      files: workspaceFiles(resolveAnchor(cwd).root, composition.scope),
      arcs: options.arcs ?? servedArcService({ ...options, sessionDir }, composition),
      bots: botService({
        cwd,
        projectTrusted,
        userRoot,
        sessionDir,
        roster: composition.extensions.bots,
      }),
    };
  });
  const arcsOf = async (): Promise<ArcService> => {
    if (!projectTrusted) throw new SurfaceUnavailableError(arcsUnavailable);
    return (await composed()).arcs;
  };
  const botsOf = async (): Promise<BotRoster> => (await composed()).bots;
  return {
    workspace: {
      report: async () => workspaceReport(options, trustStore, anchors),
      trust: async () => {
        if (trustStore.resolve(cwd) === "untrusted") {
          throw new TrustRefusedError(resolveAnchor(cwd).root);
        }
        const setup = workspaceSetupPort({
          cwd,
          trustStore,
          workspaceSlug,
          anchorMemory: anchors,
          requestReopen: () => undefined,
        });
        const { root, vault } = await setup.setUp();
        return { trusted: true, root, vault, reopens: !projectTrusted };
      },
      tree: async (path, hidden) => (await composed()).files.tree(path, hidden),
      file: async (path, range) => (await composed()).files.file(path, range),
    },
    mcp: mcpPort(async () => (await composed()).composition.mcp),
    arcs: {
      list: async () => (await arcsOf()).port.list(),
      create: async (slug) => (await arcsOf()).port.create(slug),
      close: async (slug, direction) => (await arcsOf()).port.close(slug, direction),
      abandon: async (slug) => (await arcsOf()).port.abandon(slug),
      setTheme: async (slug, theme) => (await arcsOf()).wear(slug, theme ?? undefined),
      bindSession: async (id, slug) => {
        const session = await options.session(id);
        if (session === undefined) return undefined;
        const arcs = await arcsOf();
        const arc = slug ?? undefined;
        if (session.store.arcBinding() !== arc) await session.store.appendArcBinding(arc);
        await arcs.attached(session.store);
        arcs.recordBinding(id, arc);
        await session.adoptBinding?.();
        return session.store.binding();
      },
      subscribe: (listener) =>
        lazySubscription(async () => (await arcsOf()).port.subscribe?.(listener)),
    },
    bots: {
      list: async () => (await botsOf()).list(),
      create: async (draft) => {
        if (draft.scope === "project" && !projectTrusted) {
          throw new SurfaceUnavailableError(projectBotsNeedTrust);
        }
        return (await botsOf()).create(draft);
      },
      bindSession: async (id, name) => {
        const session = await options.session(id);
        if (session === undefined) return undefined;
        if (session.busy()) throw new SessionBusyError();
        const bot = name ?? undefined;
        if (bot !== undefined && !(await botsOf()).defined().some((known) => known.name === bot)) {
          throw new Error(`no bot named ${bot} · keywork bot list shows the roster`);
        }
        if (session.store.botBinding() !== bot) await session.store.appendBotBinding(bot);
        await session.adoptBinding?.();
        return session.store.binding();
      },
    },
    workspaces: workspacesPort({
      cwd,
      current: workspaceSlug,
      recall: fileWorkspaceRecall(workspaceRecallFile(keyworkHome(userRoot))),
      requestSwitch: () => undefined,
      sessionDirFor: (slug) => (slug === workspaceSlug ? sessionDir : defaultSessionDir(cwd, slug)),
    }),
    themes: {
      list: async () => ({
        themes: wardrobe().map(completeTheme),
        active: options.theme ?? keyworkNightTheme.name,
        placeholders: [systemThemeName],
      }),
    },
  };
}

function workspaceReport(
  options: SurfacePortsOptions,
  trustStore: TrustStore,
  anchors: ReturnType<typeof fileAnchorMemory>,
): WorkspaceReport {
  const { cwd, workspaceSlug } = options;
  const workspace = openWorkspace(cwd, workspaceSlug);
  return {
    anchor: resolveAnchor(cwd),
    identity: workspaceIdentity(cwd, workspaceSlug),
    ...(workspace?.slug !== undefined && { slug: workspace.slug }),
    ...(workspace !== undefined && {
      name: workspace.name,
      declarationFile: workspace.declarationFile,
      vault: workspace.vaultPath,
    }),
    declared: workspace !== undefined,
    contextDirs: workspace?.contextDirs ?? [],
    missingContextDirs: workspace?.missingContextDirs ?? [],
    focusDirs: workspace?.focusDirs ?? [],
    trust: trustStore.resolve(cwd),
    readiness: workspaceReadiness({ cwd, trustStore, workspaceSlug }, anchors).kind,
  };
}

function mcpPort(registry: () => Promise<McpRegistry | undefined>): McpPort {
  const serving = async (name: string): Promise<McpRegistry> => {
    const found = await registry();
    if (found === undefined) throw new McpServerNotFoundError(name);
    return found;
  };
  return {
    status: async () => (await registry())?.status() ?? [],
    restart: async (name) => (await serving(name)).restart(name),
    setEnabled: async (name, on) => {
      const found = await serving(name);
      return on ? found.enable(name) : found.disable(name);
    },
    listTools: async (name) => (await serving(name)).listTools(name).map((tool) => tool.name),
    subscribe: (listener) =>
      lazySubscription(async () => (await registry())?.subscribe(() => listener())),
  };
}

function lazySubscription(open: () => Promise<(() => void) | undefined>): () => void {
  let wanted = true;
  let stop: (() => void) | undefined;
  open()
    .then((opened) => {
      if (wanted) stop = opened;
      else opened?.();
    })
    .catch(() => undefined);
  return () => {
    wanted = false;
    stop?.();
  };
}

function lazily<Value>(open: () => Promise<Value>): () => Promise<Value> {
  let pending: Promise<Value> | undefined;
  return () => {
    pending ??= open();
    return pending;
  };
}
