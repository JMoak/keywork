import { createHash } from "node:crypto";
import { isSlug, type JsonFileStore, jsonFileStore } from "@keywork/shared";
import { z } from "zod";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const slug = z.string().refine(isSlug);
const creatureHandleSchema = z.strictObject({ workspace: identity, slug });
const sessionRefSchema = z.strictObject({ workspace: identity, session: identity });
const requestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(16_000);

export const projectThreadInput = z.strictObject({
  requestId,
  text,
  source: sessionRefSchema.optional(),
});
export const projectDiscussionInput = projectThreadInput.extend({ source: sessionRefSchema });
export const projectWorkRequest = projectThreadInput.extend({
  creature: creatureHandleSchema,
  project: identity,
});
export const projectThreadJsonSchema = z.toJSONSchema(projectThreadInput);
export const projectDiscussionJsonSchema = z.toJSONSchema(projectDiscussionInput);
export const projectWorkJsonSchema = z.toJSONSchema(projectWorkRequest);

export type CreatureHandle = z.infer<typeof creatureHandleSchema>;
export type WorkspaceSessionRef = z.infer<typeof sessionRefSchema>;
export type ProjectThreadInput = z.infer<typeof projectThreadInput>;
export type ProjectDiscussionInput = z.infer<typeof projectDiscussionInput>;
export type ProjectWorkRequest = z.infer<typeof projectWorkRequest>;

export interface CreatureProjectLink {
  requestId: string;
  session: WorkspaceSessionRef;
  source?: WorkspaceSessionRef | undefined;
}

export interface CreatureProjectBinding {
  project: string;
  threads: CreatureProjectLink[];
  discussions: CreatureProjectLink[];
}

export interface CreatureProjectsPort {
  list(slug: string): Promise<CreatureProjectBinding[]>;
  bind(slug: string, project: string): Promise<CreatureProjectBinding>;
  unbind(slug: string, project: string): Promise<void>;
  run(slug: string, project: string, input: ProjectThreadInput): Promise<WorkspaceSessionRef>;
  discuss(
    slug: string,
    project: string,
    input: ProjectDiscussionInput,
  ): Promise<WorkspaceSessionRef>;
}

export interface CreatureProjectWorkPort {
  start(request: ProjectWorkRequest): Promise<WorkspaceSessionRef>;
}

export interface CreatureProjectContextOptions {
  file: string;
  workspace: string;
  generation(creature: CreatureHandle): Promise<string | undefined>;
  authorized(project: string): Promise<boolean>;
  hasSession(session: WorkspaceSessionRef): Promise<boolean>;
  start(request: ProjectWorkRequest): Promise<WorkspaceSessionRef>;
  discuss(
    request: ProjectWorkRequest & { source: WorkspaceSessionRef },
    generation: string,
  ): Promise<WorkspaceSessionRef>;
}

export type CreatureProjectRefusal =
  | "bad-input"
  | "missing-creature"
  | "untrusted-project"
  | "unbound-project"
  | "missing-session"
  | "request-conflict"
  | "unavailable";

const refusalMessages: Record<CreatureProjectRefusal, string> = {
  "bad-input": "the creature, project, or session reference is invalid",
  "missing-creature": "no creature has that handle",
  "untrusted-project": "this project is not authorized for creature work",
  "unbound-project": "bind the project to the creature first",
  "missing-session": "the selected session does not exist in this project",
  "request-conflict": "this request ID is already used for different creature work",
  unavailable: "the project context is temporarily unavailable",
};

export class CreatureProjectError extends Error {
  constructor(readonly code: CreatureProjectRefusal) {
    super(refusalMessages[code]);
    this.name = "CreatureProjectError";
  }
}

export class CreatureProjectContext implements CreatureProjectsPort {
  private readonly store: JsonFileStore<ProjectState>;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CreatureProjectContextOptions) {
    if (!identity.safeParse(options.workspace).success) throw new CreatureProjectError("bad-input");
    this.store = jsonFileStore({
      file: options.file,
      mode: "strict",
      private: true,
      validate: (data) => projectState.parse(data),
      error: () => new CreatureProjectError("unavailable"),
    });
  }

  async list(slug: string): Promise<CreatureProjectBinding[]> {
    const owner = await this.owner(slug);
    const state = this.read();
    const found = state.bindings.filter((row) => sameOwner(row, owner) && row.active);
    const visible = await Promise.all(
      found.map(async ({ project }) =>
        (await this.options.authorized(project)) ? bindingOf(state, owner, project) : undefined,
      ),
    );
    return visible.flatMap((binding) => (binding === undefined ? [] : [binding]));
  }

  bind(slug: string, project: string): Promise<CreatureProjectBinding> {
    return this.serially(async () => {
      const owner = await this.owner(slug);
      await this.requireProject(project);
      const state = this.read();
      const existing = bindingRecordOf(state, owner, project);
      if (existing === undefined) {
        state.bindings.push({ ...owner, project, active: true });
        this.write(state);
      } else if (!existing.active) {
        existing.active = true;
        this.write(state);
      }
      return bindingOf(state, owner, project);
    });
  }

  unbind(slug: string, project: string): Promise<void> {
    return this.serially(async () => {
      if (!identity.safeParse(project).success) throw new CreatureProjectError("bad-input");
      const owner = await this.owner(slug);
      const state = this.read();
      const record = bindingRecordOf(state, owner, project);
      if (record?.active !== true) return;
      record.active = false;
      this.write(state);
    });
  }

  run(slug: string, project: string, input: ProjectThreadInput): Promise<WorkspaceSessionRef> {
    return this.deliver(slug, project, "thread", input, (request) => this.options.start(request));
  }

  discuss(
    slug: string,
    project: string,
    input: ProjectDiscussionInput,
  ): Promise<WorkspaceSessionRef> {
    return this.deliver(slug, project, "discussion", input, (request, generation) => {
      if (request.source === undefined) throw new CreatureProjectError("bad-input");
      return this.options.discuss({ ...request, source: request.source }, generation);
    });
  }

  async permitsWork(input: ProjectWorkRequest): Promise<boolean> {
    return (await this.workGeneration(input)) !== undefined;
  }

  async workGeneration(input: ProjectWorkRequest): Promise<string | undefined> {
    const parsed = projectWorkRequest.safeParse(input);
    if (!parsed.success || parsed.data.creature.workspace !== this.options.workspace)
      return undefined;
    const { creature, project, requestId } = parsed.data;
    if (project === this.options.workspace || !(await this.options.authorized(project)))
      return undefined;
    const generation = await this.options.generation(creature);
    if (generation === undefined) return undefined;
    const owner = { creature, generation };
    const state = this.read();
    const allowed =
      bindingRecordOf(state, owner, project)?.active === true &&
      requestRecordOf(state, owner, requestId)?.digest === digestOf("thread", parsed.data);
    return allowed ? generation : undefined;
  }

  private deliver(
    slug: string,
    project: string,
    kind: RequestKind,
    input: ProjectThreadInput,
    send: (request: ProjectWorkRequest, generation: string) => Promise<WorkspaceSessionRef>,
  ): Promise<WorkspaceSessionRef> {
    return this.serially(async () => {
      const owner = await this.owner(slug);
      const request = parsedRequest(kind, owner.creature, project, input);
      await this.requireProject(project);
      const state = this.read();
      if (bindingRecordOf(state, owner, project)?.active !== true)
        throw new CreatureProjectError("unbound-project");
      const digest = digestOf(kind, request);
      const existing = requestRecordOf(state, owner, request.requestId);
      if (existing !== undefined && existing.digest !== digest)
        throw new CreatureProjectError("request-conflict");
      if (existing?.session !== undefined) return existing.session;
      const source = request.source;
      if (source !== undefined && !(await this.options.hasSession(source)))
        throw new CreatureProjectError("missing-session");
      const record: RequestRecord = existing ?? {
        ...owner,
        kind,
        project,
        requestId: request.requestId,
        digest,
        source,
      };
      if (existing === undefined) {
        state.requests.push(record);
        this.write(state);
      }
      const answer = await send(request, owner.generation);
      const expected = kind === "thread" ? project : owner.creature.workspace;
      const session = sessionRefSchema.safeParse(answer);
      if (!session.success || session.data.workspace !== expected)
        throw new CreatureProjectError("unavailable");
      record.session = session.data;
      this.write(state);
      return session.data;
    });
  }

  private async owner(candidate: string): Promise<Owner> {
    const parsed = creatureHandleSchema.safeParse({
      workspace: this.options.workspace,
      slug: candidate,
    });
    if (!parsed.success) throw new CreatureProjectError("bad-input");
    const creature = parsed.data;
    const generation = await this.options.generation(creature);
    if (generation === undefined) throw new CreatureProjectError("missing-creature");
    return { creature, generation };
  }

  private async requireProject(project: string): Promise<void> {
    if (!identity.safeParse(project).success || project === this.options.workspace)
      throw new CreatureProjectError("bad-input");
    if (!(await this.options.authorized(project)))
      throw new CreatureProjectError("untrusted-project");
  }

  private read(): ProjectState {
    try {
      return this.store.read() ?? { bindings: [], requests: [] };
    } catch {
      throw new CreatureProjectError("unavailable");
    }
  }

  private write(state: ProjectState): void {
    try {
      this.store.write(state);
    } catch {
      throw new CreatureProjectError("unavailable");
    }
  }

  private serially<T>(act: () => Promise<T>): Promise<T> {
    const running = this.pending.then(act);
    this.pending = running.catch(() => undefined);
    return running;
  }
}

const ownerSchema = z.strictObject({
  creature: creatureHandleSchema,
  generation: z.string().min(1),
});
const bindingSchema = ownerSchema.extend({ project: identity, active: z.boolean() });
const requestKind = z.enum(["thread", "discussion"]);
const requestSchema = ownerSchema.extend({
  kind: requestKind,
  project: identity,
  requestId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  source: sessionRefSchema.optional(),
  session: sessionRefSchema.optional(),
});
const projectState = z.strictObject({
  bindings: z.array(bindingSchema),
  requests: z.array(requestSchema),
});

type Owner = z.infer<typeof ownerSchema>;
type RequestKind = z.infer<typeof requestKind>;
type RequestRecord = z.infer<typeof requestSchema>;
type ProjectState = z.infer<typeof projectState>;

function sameOwner(left: Owner, right: Owner): boolean {
  return (
    left.creature.workspace === right.creature.workspace &&
    left.creature.slug === right.creature.slug &&
    left.generation === right.generation
  );
}

function bindingRecordOf(state: ProjectState, owner: Owner, project: string) {
  return state.bindings.find((row) => sameOwner(row, owner) && row.project === project);
}

function requestRecordOf(state: ProjectState, owner: Owner, requestId: string) {
  return state.requests.find((row) => sameOwner(row, owner) && row.requestId === requestId);
}

function bindingOf(state: ProjectState, owner: Owner, project: string): CreatureProjectBinding {
  const result: CreatureProjectBinding = { project, threads: [], discussions: [] };
  for (const row of state.requests) {
    if (row.project !== project || !sameOwner(row, owner) || row.session === undefined) continue;
    const links = row.kind === "thread" ? result.threads : result.discussions;
    links.push({
      requestId: row.requestId,
      session: row.session,
      ...(row.source !== undefined && { source: row.source }),
    });
  }
  return result;
}

function parsedRequest(
  kind: RequestKind,
  creature: CreatureHandle,
  project: string,
  input: ProjectThreadInput,
): ProjectWorkRequest {
  const body = (kind === "thread" ? projectThreadInput : projectDiscussionInput).safeParse(input);
  const checked = projectWorkRequest.safeParse({ ...input, creature, project });
  if (
    !body.success ||
    !checked.success ||
    (checked.data.source !== undefined && checked.data.source.workspace !== project)
  )
    throw new CreatureProjectError("bad-input");
  return checked.data;
}

function digestOf(kind: RequestKind, request: ProjectWorkRequest): string {
  const { creature, project, requestId, text, source } = request;
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        creature.workspace,
        creature.slug,
        project,
        requestId,
        text,
        source?.workspace,
        source?.session,
      ]),
    )
    .digest("hex");
}
