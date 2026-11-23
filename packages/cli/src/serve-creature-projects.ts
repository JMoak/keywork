import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type CreatureHandle,
  CreatureProjectContext,
  CreatureProjectError,
  type CreatureProjectsPort,
  type CreatureProjectWorkPort,
  CreatureRegistry,
  type CreatureWorksite,
  type ProjectWorkRequest,
  type WorkspaceSessionRef,
} from "@keywork/engine";
import { contractVersion, readServerTicket, type ServerTicket } from "@keywork/server";
import { canonicalPath, resolveAnchor, TrustStore } from "@keywork/shared";
import { existingManagedHome, keyworkHome, managedHomeFolder, workspaceIdentity } from "./paths.ts";
import { keyworkVersion } from "./version.ts";

export interface ServedCreatureProjectsOptions {
  cwd: string;
  userRoot: string;
  workspaceSlug?: string | undefined;
  managedHome?: boolean | undefined;
  projectTrusted: boolean;
  registry: Pick<CreatureRegistry, "read">;
  start(request: ProjectWorkRequest, generation: string): Promise<WorkspaceSessionRef>;
  discuss(request: ProjectWorkRequest, generation: string): Promise<WorkspaceSessionRef>;
  projectWorksites?: ProjectWorksites | undefined;
}

export interface ProjectWorksites {
  visited(project: string, worksites: readonly CreatureWorksite[]): void;
  quiet(project: string): void;
}

export interface ServedCreatureProjects {
  creatureProjects?: CreatureProjectsPort;
  creatureProjectWork?: CreatureProjectWorkPort;
  followProjects(creatures: readonly string[]): Promise<void>;
  close(): void;
}

export function servedCreatureProjects(
  options: ServedCreatureProjectsOptions,
): ServedCreatureProjects {
  const workspace = workspaceIdentity(options.cwd, options.workspaceSlug);
  const trust = new TrustStore({ home: options.userRoot });
  const home = managedHomeFolder(options.userRoot);
  const projectTicket = (project: string) => trustedProjectTicket(project, options.userRoot, trust);
  if (options.managedHome === true) {
    const creatureProjects = new CreatureProjectContext({
      file: contextFile(home),
      workspace,
      generation: (creature) => generationOf(options.registry, creature),
      authorized: async (project) => (await projectTicket(project)) !== undefined,
      hasSession: async (ref) => {
        const ticket = await projectTicket(ref.workspace);
        if (ticket === undefined) return false;
        const listing = await readProjectJson(ticket, "/sessions");
        return hasSession(listing, ref.session);
      },
      start: async (request) => {
        const ticket = await projectTicket(request.project);
        if (ticket === undefined) throw new CreatureProjectError("untrusted-project");
        return sendWork(ticket, request);
      },
      discuss: options.discuss,
    });
    const watches = projectWatches({
      workspace,
      projectTicket,
      worksites: options.projectWorksites,
      creaturesIn: (project, slugs) => creaturesWorkingIn(creatureProjects, project, slugs),
    });
    return {
      creatureProjects: followingProjectThreads(creatureProjects, watches),
      followProjects: async (creatures) => {
        for (const project of await projectsWorkedIn(creatureProjects, creatures)) {
          watches.follow(project, false);
        }
      },
      close: watches.close,
    };
  }
  return {
    followProjects: async () => {},
    close: () => {},
    creatureProjectWork: {
      start: async (request) => {
        const anchor = resolveAnchor(options.cwd).root;
        if (
          request.project !== workspace ||
          !options.projectTrusted ||
          trust.resolve(anchor) !== "trusted"
        ) {
          throw new CreatureProjectError("untrusted-project");
        }
        const actualHome = existingManagedHome(options.userRoot);
        if (
          actualHome === undefined ||
          lstatSync(contextFile(actualHome), { throwIfNoEntry: false })?.isFile() !== true
        ) {
          throw new CreatureProjectError("untrusted-project");
        }
        const registry = new CreatureRegistry({ root: actualHome, trusted: true, keeper: "" });
        const authority = new CreatureProjectContext({
          file: contextFile(actualHome),
          workspace: workspaceIdentity(actualHome),
          generation: (creature) => generationOf(registry, creature),
          authorized: async (project) =>
            project === workspace && trust.resolve(anchor) === "trusted",
          hasSession: async () => false,
          start: refuseUnserved,
          discuss: refuseUnserved,
        });
        const generation = await authority.workGeneration(request);
        if (generation === undefined) throw new CreatureProjectError("untrusted-project");
        return options.start(request, generation);
      },
    },
  };
}

function followingProjectThreads(
  context: CreatureProjectContext,
  watches: ProjectWatches,
): CreatureProjectsPort {
  return {
    list: (slug) => context.list(slug),
    bind: (slug, project) => context.bind(slug, project),
    unbind: (slug, project) => context.unbind(slug, project),
    discuss: (slug, project, input) => context.discuss(slug, project, input),
    run: async (slug, project, input) => {
      const session = await context.run(slug, project, input);
      watches.follow(project, true);
      return session;
    },
  };
}

interface ProjectWatchOptions {
  workspace: string;
  projectTicket(project: string): Promise<ServerTicket | undefined>;
  worksites: ProjectWorksites | undefined;
  creaturesIn(project: string, slugs: readonly string[]): Promise<ReadonlySet<string>>;
}

interface ProjectWatches {
  follow(project: string, wait: boolean): void;
  close(): void;
}

const projectWatchMs = 1_000;

function projectWatches(options: ProjectWatchOptions): ProjectWatches {
  const { worksites } = options;
  const watching = new Map<string, { again: boolean }>();
  let closed = false;
  const visit = async (ticket: ServerTicket, project: string): Promise<number | undefined> => {
    const path = `/creature-worksites?visitor=${encodeURIComponent(options.workspace)}`;
    const answer = visitorWorksitesOf(await readProjectJson(ticket, path));
    if (answer === undefined || worksites === undefined) return undefined;
    const own = await options.creaturesIn(project, [
      ...new Set(answer.worksites.map((row) => row.creature)),
    ]);
    worksites.visited(
      project,
      answer.worksites.filter((row) => own.has(row.creature)),
    );
    return answer.working;
  };
  const watch = async (project: string, wait: boolean, state: { again: boolean }) => {
    const ticket = await options.projectTicket(project);
    if (ticket === undefined) return;
    for (let first = true; !closed; first = false) {
      if (wait || !first) await pause(projectWatchMs);
      if (closed) return;
      const working = await visit(ticket, project);
      if (working === undefined) return worksites?.quiet(project);
      if (working === 0 && !state.again) return;
      state.again = false;
    }
  };
  return {
    follow: (project, wait) => {
      if (closed || worksites === undefined) return;
      const running = watching.get(project);
      if (running !== undefined) {
        running.again = true;
        return;
      }
      const state = { again: false };
      watching.set(project, state);
      void watch(project, wait, state)
        .catch(() => worksites.quiet(project))
        .finally(() => watching.delete(project));
    },
    close: () => {
      closed = true;
    },
  };
}

async function projectsWorkedIn(
  context: CreatureProjectContext,
  creatures: readonly string[],
): Promise<Set<string>> {
  const projects = new Set<string>();
  for (const creature of creatures) {
    for (const binding of await context.worked(creature).catch(() => [])) {
      if (binding.threads.length > 0) projects.add(binding.project);
    }
  }
  return projects;
}

async function creaturesWorkingIn(
  context: CreatureProjectContext,
  project: string,
  slugs: readonly string[],
): Promise<ReadonlySet<string>> {
  const working = new Set<string>();
  for (const slug of slugs) {
    if ((await projectsWorkedIn(context, [slug])).has(project)) working.add(slug);
  }
  return working;
}

function visitorWorksitesOf(
  data: unknown,
): { worksites: CreatureWorksite[]; working: number } | undefined {
  const worksites = field(data, "worksites");
  const working = field(data, "working");
  if (!Array.isArray(worksites) || typeof working !== "number") return undefined;
  return { worksites: worksites.flatMap(visitedWorksiteOf), working };
}

function visitedWorksiteOf(row: unknown): CreatureWorksite[] {
  const [creature, directory, root, since, latest] = [
    "creature",
    "directory",
    "root",
    "since",
    "latest",
  ].map((name) => field(row, name));
  const conversations = field(row, "conversations");
  const active = field(row, "active");
  if (
    typeof creature !== "string" ||
    typeof directory !== "string" ||
    typeof root !== "string" ||
    typeof since !== "string" ||
    typeof latest !== "string" ||
    typeof conversations !== "number" ||
    typeof active !== "boolean"
  )
    return [];
  return [{ creature, directory, root, project: null, conversations, since, latest, active }];
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function contextFile(home: string): string {
  return join(home, ".keywork", "project-context.json");
}

async function generationOf(
  registry: Pick<CreatureRegistry, "read">,
  creature: CreatureHandle,
): Promise<string | undefined> {
  const found = await registry.read(creature.slug);
  return found === undefined ? undefined : `${found.file.created}:${found.file.body.seed}`;
}

async function trustedProjectTicket(
  project: string,
  userRoot: string,
  trust: TrustStore,
): Promise<ServerTicket | undefined> {
  if (!/^[a-f0-9]{12}$/.test(project)) return undefined;
  const ticket = readServerTicket(
    join(keyworkHome(userRoot), "workspaces", project, "server.json"),
  );
  if (ticket === undefined || !localTicket(ticket)) return undefined;
  const home = canonicalPath(managedHomeFolder(userRoot));
  const [document, report] = await Promise.all([
    readProjectJson(ticket, "/doc"),
    readProjectJson(ticket, "/workspace"),
  ]);
  const info = field(document, "info");
  const root = field(field(report, "anchor"), "root");
  const slug = field(report, "slug");
  if (
    field(info, "title") !== "keywork" ||
    field(info, "version") !== keyworkVersion ||
    field(info, "x-keywork-contract") !== contractVersion ||
    field(report, "identity") !== project ||
    field(report, "trust") !== "trusted" ||
    typeof root !== "string" ||
    canonicalPath(root) === home ||
    trust.resolve(root) !== "trusted" ||
    workspaceIdentity(root, typeof slug === "string" ? slug : undefined) !== project
  )
    return undefined;
  return ticket;
}

function localTicket(ticket: ServerTicket): boolean {
  try {
    const url = new URL(ticket.url);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function readProjectJson(ticket: ServerTicket, path: string): Promise<unknown> {
  try {
    const response = await fetch(new URL(path, ticket.url), {
      headers: { authorization: `Bearer ${ticket.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

async function sendWork(
  ticket: ServerTicket,
  request: ProjectWorkRequest,
): Promise<WorkspaceSessionRef> {
  try {
    const response = await fetch(new URL("/creature-project-work", ticket.url), {
      method: "POST",
      headers: { authorization: `Bearer ${ticket.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 403) throw new CreatureProjectError("untrusted-project");
    if (response.status !== 202) throw new CreatureProjectError("unavailable");
    const session = field(await response.json(), "session");
    const workspace = field(session, "workspace");
    const id = field(session, "session");
    if (workspace !== request.project || typeof id !== "string")
      throw new CreatureProjectError("unavailable");
    return { workspace, session: id };
  } catch (cause) {
    if (cause instanceof CreatureProjectError) throw cause;
    throw new CreatureProjectError("unavailable");
  }
}

function hasSession(listing: unknown, id: string): boolean {
  const sessions = field(listing, "sessions");
  return Array.isArray(sessions) && sessions.some((session) => field(session, "id") === id);
}

function field(data: unknown, name: string): unknown {
  if (typeof data !== "object" || data === null || !Object.hasOwn(data, name)) return undefined;
  return (data as Record<string, unknown>)[name];
}

async function refuseUnserved(): Promise<never> {
  throw new CreatureProjectError("unavailable");
}
