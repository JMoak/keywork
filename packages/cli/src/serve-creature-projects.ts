import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type CreatureHandle,
  type CreatureLedgerEntry,
  CreatureProjectContext,
  CreatureProjectError,
  type CreatureProjectsPort,
  type CreatureProjectWorkPort,
  CreatureRegistry,
  type CreatureScene,
  type CreatureWorksite,
  ledgerEntriesOf,
  type ProjectWorkRequest,
  type SceneKeeping,
  type SceneKeepingInput,
  type VisitorWork,
  type WorkspaceSessionRef,
} from "@keywork/engine";
import {
  contractVersion,
  readServerTicket,
  type SceneSetOutAnswer,
  type ServerTicket,
} from "@keywork/server";
import { canonicalPath, resolveAnchor, TrustStore } from "@keywork/shared";
import { existingManagedHome, keyworkHome, managedHomeFolder, workspaceIdentity } from "./paths.ts";
import type { HomeScenes } from "./serve-visiting.ts";
import { keyworkVersion } from "./version.ts";

export interface ServedCreatureProjectsOptions {
  cwd: string;
  userRoot: string;
  workspaceSlug?: string | undefined;
  managedHome?: boolean | undefined;
  projectTrusted: boolean;
  registry: Pick<CreatureRegistry, "read" | "list">;
  start(request: ProjectWorkRequest, generation: string): Promise<WorkspaceSessionRef>;
  discuss(request: ProjectWorkRequest, generation: string): Promise<WorkspaceSessionRef>;
  projectWorksites?: ProjectWorksites | undefined;
  projectHonours?: ProjectHonours | undefined;
  projectLedger?: ProjectLedger | undefined;
}

export interface ProjectLedger {
  visited(project: string, creature: string, entries: readonly CreatureLedgerEntry[]): void;
}

export interface ProjectWorksites {
  visited(project: string, worksites: readonly CreatureWorksite[]): void;
  quiet(project: string): void;
}

export interface ProjectHonours {
  visited(project: string, work: readonly VisitorWork[]): void;
}

export interface ServedCreatureProjects {
  creatureProjects?: CreatureProjectsPort;
  creatureProjectWork?: CreatureProjectWorkPort;
  setOutInProject(project: string, slug: string, name: string): Promise<SceneSetOutAnswer>;
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
    const creatures = async () => (await options.registry.list()).map(({ slug }) => slug);
    const watches = projectWatches({
      workspace,
      projectTicket,
      worksites: options.projectWorksites,
      honours: options.projectHonours,
      ledger: options.projectLedger,
      creatures,
      creaturesIn: (project, slugs) => creaturesWorkingIn(creatureProjects, project, slugs),
    });
    return {
      creatureProjects: {
        ...followingProjectThreads(creatureProjects, watches),
        changed: async (project) => {
          const worked = await projectsWorkedIn(creatureProjects, await creatures());
          if (worked.has(project)) watches.follow(project, false);
        },
      },
      setOutInProject: async (project, slug, name) => {
        const ticket = await projectTicket(project);
        const visitor = `?visitor=${encodeURIComponent(workspace)}`;
        const answer =
          ticket === undefined
            ? undefined
            : await sendJson(ticket, "POST", `${scenePath(slug, name)}/set-out${visitor}`);
        return setOutAnswerOf(answer?.body) ?? projectSilent;
      },
      followProjects: async (creatures) => {
        for (const project of await projectsWorkedIn(creatureProjects, creatures)) {
          watches.follow(project, false);
        }
      },
      close: watches.close,
    };
  }
  return {
    setOutInProject: async () => projectSilent,
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

export function tellingTheHome(userRoot: string, project: string): () => void {
  let telling: Promise<void> | undefined;
  let again = false;
  const tell = async () => {
    const home = managedHomeIdentity(userRoot);
    const ticket = home === undefined ? undefined : await homeTicketOf(userRoot, home);
    if (ticket === undefined) return;
    await sendJson(ticket, "POST", `/creature-projects/${encodeURIComponent(project)}/changed`, {});
  };
  return () => {
    if (telling !== undefined) {
      again = true;
      return;
    }
    telling = (async () => {
      do {
        again = false;
        await tell();
      } while (again);
    })().finally(() => {
      telling = undefined;
    });
  };
}

export function homeScenesOver(userRoot: string): HomeScenes {
  return {
    keep: async (creature, name, keeping) => {
      const path = scenePath(creature.slug, name);
      const answer = await toTheHome(userRoot, creature, "PUT", path, keeping);
      return keptAtHome(answer, keeping) ?? homeRefused(answer);
    },
    forget: async (creature, name) => {
      const answer = await toTheHome(userRoot, creature, "DELETE", scenePath(creature.slug, name));
      if (answer.status === 204 || answer.status === 404) return answer.status === 204;
      return homeRefused(answer);
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
  honours?: ProjectHonours | undefined;
  ledger?: ProjectLedger | undefined;
  creatures(): Promise<readonly string[]>;
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
  const visitor = `?visitor=${encodeURIComponent(options.workspace)}`;
  const visit = async (ticket: ServerTicket, project: string): Promise<number | undefined> => {
    const answer = visitorWorksitesOf(
      await readProjectJson(ticket, `/creature-worksites${visitor}`),
    );
    if (answer === undefined || worksites === undefined) return undefined;
    const own = await options.creaturesIn(project, [
      ...new Set(answer.worksites.map((row) => row.creature)),
    ]);
    worksites.visited(
      project,
      answer.worksites.filter((row) => own.has(row.creature)),
    );
    await visitHonours(ticket, project);
    await visitLedgers(ticket, project);
    return answer.working;
  };
  const visitLedgers = async (ticket: ServerTicket, project: string): Promise<void> => {
    if (options.ledger === undefined) return;
    for (const slug of await options.creaturesIn(project, await options.creatures())) {
      const view = await readProjectJson(
        ticket,
        `/creatures/${encodeURIComponent(slug)}/ledger${visitor}`,
      );
      options.ledger.visited(project, slug, ledgerEntriesOf(field(view, "entries")));
    }
  };
  const visitHonours = async (ticket: ServerTicket, project: string): Promise<void> => {
    if (options.honours === undefined) return;
    const work = visitorWorkOf(await readProjectJson(ticket, `/creature-honours${visitor}`));
    const own = await options.creaturesIn(project, [...new Set(work.map((row) => row.creature))]);
    options.honours.visited(
      project,
      work.filter((row) => own.has(row.creature)),
    );
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

function visitorWorkOf(data: unknown): VisitorWork[] {
  const work = field(data, "work");
  return Array.isArray(work) ? work.flatMap(visitedWorkOf) : [];
}

function visitedWorkOf(row: unknown): VisitorWork[] {
  const creature = field(row, "creature");
  const conversations = times(field(row, "conversations"));
  const days = times(field(row, "days"));
  const night = field(row, "night");
  const tools = field(row, "tools");
  if (
    typeof creature !== "string" ||
    conversations === undefined ||
    days === undefined ||
    (night !== null && typeof night !== "string") ||
    typeof tools !== "object" ||
    tools === null
  )
    return [];
  const uses = Object.entries(tools).flatMap(([tool, at]): [string, string[]][] => {
    const said = times(at);
    return said === undefined ? [] : [[tool, said.slice(0, 10)]];
  });
  return [{ creature, conversations, night, tools: Object.fromEntries(uses), days }];
}

function times(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const said = value.filter(
    (at): at is string => typeof at === "string" && !Number.isNaN(Date.parse(at)),
  );
  return said.length === value.length ? said : undefined;
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

interface Answered {
  status: number;
  body: unknown;
}

async function toTheHome(
  userRoot: string,
  creature: CreatureHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answered> {
  const ticket = await homeTicketOf(userRoot, creature.workspace);
  const answer = ticket === undefined ? undefined : await sendJson(ticket, method, path, body);
  return answer ?? homeRefused(undefined);
}

function keptAtHome(answer: Answered, sent: SceneKeepingInput): SceneKeeping | undefined {
  if (answer.status === 409) {
    const scenes = field(answer.body, "scenes");
    return Array.isArray(scenes) ? { full: scenes as CreatureScene[] } : undefined;
  }
  const scene = field(answer.body, "scene");
  const replaced = field(answer.body, "replaced");
  if (answer.status !== 200 || typeof field(scene, "name") !== "string") return undefined;
  if (typeof replaced !== "boolean") return undefined;
  const kept = { ...(scene as CreatureScene), things: sent.things, keptIn: sent.keptIn };
  return { kept, replaced };
}

function homeRefused(answer: Answered | undefined): never {
  const said = field(answer?.body, "error");
  throw new Error(
    typeof said === "string"
      ? `the stead's home refused: ${said}`
      : "the stead's home did not answer, so nothing was changed; try again in a moment",
  );
}

function managedHomeIdentity(userRoot: string): string | undefined {
  try {
    const home = existingManagedHome(userRoot);
    return home === undefined ? undefined : workspaceIdentity(home);
  } catch {
    return undefined;
  }
}

async function homeTicketOf(userRoot: string, home: string): Promise<ServerTicket | undefined> {
  if (!/^[a-f0-9]{12}$/.test(home)) return undefined;
  const ticket = readServerTicket(join(keyworkHome(userRoot), "workspaces", home, "server.json"));
  if (ticket === undefined || !localTicket(ticket)) return undefined;
  const report = await readProjectJson(ticket, "/workspace");
  const root = field(field(report, "anchor"), "root");
  if (
    field(report, "identity") !== home ||
    typeof root !== "string" ||
    canonicalPath(root) !== canonicalPath(managedHomeFolder(userRoot))
  )
    return undefined;
  return ticket;
}

async function sendJson(
  ticket: ServerTicket,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answered | undefined> {
  try {
    const response = await fetch(new URL(path, ticket.url), {
      method,
      headers: { authorization: `Bearer ${ticket.token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function scenePath(slug: string, name: string): string {
  return `/creatures/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(name)}`;
}

function setOutAnswerOf(data: unknown): SceneSetOutAnswer | undefined {
  const out = field(data, "out");
  const missing = field(data, "missing");
  const asking = field(data, "asking");
  const stopped = field(data, "stopped");
  if (
    typeof out !== "number" ||
    !isWords(missing) ||
    !isWords(asking) ||
    (stopped !== null && typeof stopped !== "string")
  )
    return undefined;
  return { out, missing, asking, stopped };
}

function isWords(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((said) => typeof said === "string");
}

const projectSilent: SceneSetOutAnswer = {
  out: 0,
  missing: [],
  asking: [],
  stopped:
    "the scene was kept in a bound project, and that project's runtime did not answer, so nothing was set out; open the project and press again",
};
