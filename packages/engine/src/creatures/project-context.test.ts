import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it, vi } from "vitest";
import {
  CreatureProjectContext,
  type CreatureProjectContextOptions,
  type ProjectWorkRequest,
  type WorkspaceSessionRef,
} from "./project-context.ts";

const scratch = scratchDirs("keywork-creature-projects-");
const home = "managed-home";
const project = "project-one";
const otherProject = "project-two";
const slug = "pip";
const text = "Review the project build.";
const thread = { workspace: project, session: "thread-1" };
const conversation = { workspace: home, session: "conversation-1" };
const focus = { workspace: project, session: "ide-1" };
const input = { requestId: "request-1", text, source: focus };

async function fixture() {
  const file = join(await scratch(), "project-context.json");
  const authorized = new Set([project]);
  const generations = new Map([[slug, "first"]]);
  const start = vi.fn(async (_request: ProjectWorkRequest): Promise<WorkspaceSessionRef> => thread);
  const discuss = vi.fn(
    async (_request: ProjectWorkRequest & { source: WorkspaceSessionRef }) => conversation,
  );
  const hasSession = vi.fn(
    async (session: WorkspaceSessionRef) =>
      session.workspace === project && session.session === focus.session,
  );
  const options: CreatureProjectContextOptions = {
    file,
    workspace: home,
    authorized: async (id) => authorized.has(id),
    generation: async (creature) => generations.get(creature.slug),
    hasSession,
    start,
    discuss,
  };
  const reopen = (workspace = home) => new CreatureProjectContext({ ...options, workspace });
  return { authorized, generations, start, discuss, hasSession, context: reopen(), reopen, file };
}

describe("qualified creature project bindings", () => {
  it("starts empty, binds one authorized project explicitly, and preserves the association across restart", async () => {
    const { context, reopen } = await fixture();
    expect(await context.list(slug)).toEqual([]);
    await expect(context.run(slug, project, input)).rejects.toMatchObject({
      code: "unbound-project",
    });
    await expect(context.bind(slug, otherProject)).rejects.toMatchObject({
      code: "untrusted-project",
    });
    await expect(context.bind(slug, home)).rejects.toMatchObject({ code: "bad-input" });
    await expect(context.bind(slug, "../project")).rejects.toMatchObject({ code: "bad-input" });
    await expect(context.bind("different-creature", project)).rejects.toMatchObject({
      code: "missing-creature",
    });
    const bound = { project, threads: [], discussions: [] };
    expect(await context.bind(slug, project)).toEqual(bound);
    expect(await reopen().bind(slug, project)).toEqual(bound);
    expect(await reopen().list(slug)).toEqual([bound]);
  });

  it("keeps a same-named creature in another workspace or a new generation separate", async () => {
    const { context, generations, reopen } = await fixture();
    await context.bind(slug, project);
    expect(await reopen("legacy-workspace").list(slug)).toEqual([]);
    generations.set(slug, "second");
    expect(await reopen().list(slug)).toEqual([]);
  });

  it("hides revoked work and can rebind a trusted project without moving its old thread", async () => {
    const { context, authorized, start } = await fixture();
    await context.bind(slug, project);
    await context.run(slug, project, input);
    authorized.clear();
    expect(await context.list(slug)).toEqual([]);
    await expect(context.run(slug, project, input)).rejects.toMatchObject({
      code: "untrusted-project",
    });
    await context.unbind(slug, project);
    authorized.add(project);
    expect(await context.list(slug)).toEqual([]);
    await expect(context.run(slug, project, input)).rejects.toMatchObject({
      code: "unbound-project",
    });
    expect((await context.bind(slug, project)).threads).toEqual([
      { requestId: input.requestId, source: focus, session: thread },
    ]);
    expect(await context.run(slug, project, input)).toEqual(thread);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("project work and explicit discussion", () => {
  it("dispatches once across simultaneous retries and does not accept a reused ID with changed text", async () => {
    const { context, reopen, start, file } = await fixture();
    await context.bind(slug, project);
    expect(
      await Promise.all([context.run(slug, project, input), context.run(slug, project, input)]),
    ).toEqual([thread, thread]);
    expect(await reopen().run(slug, project, input)).toEqual(thread);
    expect(start).toHaveBeenCalledExactlyOnceWith({
      ...input,
      project,
      creature: { workspace: home, slug },
    });
    await expect(
      context.run(slug, project, { ...input, text: "Different work." }),
    ).rejects.toMatchObject({ code: "request-conflict" });
    expect(await readFile(file, "utf8")).not.toContain(text);
  });

  it("persists an intent before dispatch and lets a receiver authenticate a retried request", async () => {
    const { context, reopen, start } = await fixture();
    await context.bind(slug, project);
    const request = { ...input, project, creature: { workspace: home, slug } };
    expect(await context.permitsWork(request)).toBe(false);
    start.mockImplementationOnce(async (sent) => {
      expect(await reopen().permitsWork(sent)).toBe(true);
      throw new Error("the receiver's response was lost");
    });
    await expect(context.run(slug, project, input)).rejects.toThrow("response was lost");
    expect(await reopen().permitsWork({ ...request, text: "A forged prompt." })).toBe(false);
    expect(
      await reopen().permitsWork({
        ...request,
        creature: { workspace: "other-home", slug },
      }),
    ).toBe(false);
    expect(await reopen().run(slug, project, input)).toEqual(thread);
    expect(start.mock.calls).toEqual([[request], [request]]);
    await context.unbind(slug, project);
    expect(await reopen().permitsWork(request)).toBe(false);
  });

  it("sends only explicit discussion text to the home conversation, leaving the IDE session as a reference", async () => {
    const { context, reopen, start, discuss, hasSession } = await fixture();
    await context.bind(slug, project);
    expect(await context.discuss(slug, project, input)).toEqual(conversation);
    expect(await reopen().discuss(slug, project, input)).toEqual(conversation);
    expect(hasSession).toHaveBeenCalledExactlyOnceWith(focus);
    expect(discuss).toHaveBeenCalledExactlyOnceWith(
      { ...input, project, creature: { workspace: home, slug } },
      "first",
    );
    expect(start).not.toHaveBeenCalled();
    expect(await reopen().list(slug)).toEqual([
      {
        project,
        threads: [],
        discussions: [{ requestId: input.requestId, source: focus, session: conversation }],
      },
    ]);
  });

  it("refuses a source outside the chosen project and a missing IDE session", async () => {
    const { context, hasSession, discuss } = await fixture();
    await context.bind(slug, project);
    await expect(
      context.discuss(slug, project, {
        ...input,
        source: { ...focus, workspace: otherProject },
      }),
    ).rejects.toMatchObject({ code: "bad-input" });
    expect(hasSession).not.toHaveBeenCalled();
    await expect(
      context.discuss(slug, project, {
        ...input,
        source: { ...focus, session: "missing" },
      }),
    ).rejects.toMatchObject({ code: "missing-session" });
    expect(discuss).not.toHaveBeenCalled();
  });

  it("fails closed when the persisted authority is malformed or dispatch returns a foreign session", async () => {
    const { context, start, file } = await fixture();
    await context.bind(slug, project);
    start.mockResolvedValueOnce(conversation);
    await expect(context.run(slug, project, input)).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(file, "{}");
    await expect(context.run(slug, project, input)).rejects.toMatchObject({ code: "unavailable" });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
