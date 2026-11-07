import { CreatureProjectError, MockProvider, type ProjectWorkRequest } from "@keywork/engine";
import { describe, expect, it, vi } from "vitest";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import { memorySessionHost } from "../testing.ts";
import { creatureProjectFamily, creatureProjectRoutes } from "./creature-projects.ts";

const params = { slug: "pip", project: "project-one" };
const focus = { workspace: params.project, session: "ide-session" };
const input = { requestId: "request-1", text: "Review the build.", source: focus };
const projectSession = { workspace: params.project, session: "project-thread" };
const homeSession = { workspace: "managed-home", session: "home-conversation" };
const binding = { project: params.project, threads: [], discussions: [] };

function handlers(
  ports: Pick<SessionHost, "creatureProjects" | "creatureProjectWork"> = {},
  log = new EventLog(),
) {
  const host = { ...memorySessionHost({ log, provider: new MockProvider([]) }), ...ports };
  return creatureProjectFamily.handlers({
    host,
    log,
    describe: fixtureDocument,
    streams: { add: () => () => undefined },
  });
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1", { method: "POST", body: JSON.stringify(body) });
}

function ports() {
  return {
    creatureProjects: {
      list: vi.fn(async () => [binding]),
      bind: vi.fn(async () => binding),
      unbind: vi.fn(async () => undefined),
      run: vi.fn(async () => projectSession),
      discuss: vi.fn(async () => homeSession),
    },
    creatureProjectWork: { start: vi.fn(async (_request: ProjectWorkRequest) => projectSession) },
  };
}

describe("creature project routes", () => {
  it("requires the local ticket and refuses hosts that do not serve the requested port", async () => {
    expect(creatureProjectRoutes.every(({ authenticated }) => authenticated)).toBe(true);
    const route = handlers();
    expect((await route.listCreatureProjects(new Request("http://127.0.0.1"), params)).status).toBe(
      503,
    );
    expect((await route.receiveCreatureProjectWork(post(input), params)).status).toBe(503);
  });

  it("hands only the qualified project selection to the binding port", async () => {
    const seam = ports();
    const route = handlers(seam);
    const selection = new Request("http://127.0.0.1", { method: "PUT" });
    const response = await route.bindCreatureProject(selection, params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(binding);
    expect(seam.creatureProjects.bind).toHaveBeenCalledExactlyOnceWith(params.slug, params.project);
  });

  it("separates project-thread execution from explicit discussion in the home conversation", async () => {
    const seam = ports();
    const log = new EventLog();
    const route = handlers(seam, log);
    const thread = await route.startCreatureProjectThread(post(input), params);
    expect(thread.status).toBe(202);
    expect(await thread.json()).toEqual({ session: projectSession });
    const discussed = await route.discussCreatureProjectSession(post(input), params);
    expect(discussed.status).toBe(202);
    expect(await discussed.json()).toEqual({ session: homeSession });
    expect(seam.creatureProjects.run).toHaveBeenCalledExactlyOnceWith(
      params.slug,
      params.project,
      input,
    );
    expect(seam.creatureProjects.discuss).toHaveBeenCalledExactlyOnceWith(
      params.slug,
      params.project,
      input,
    );
    expect(log.since(0).map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "creature.changed", payload: { slug: params.slug, change: "threads" } },
      { type: "creature.changed", payload: { slug: params.slug, change: "threads" } },
    ]);
  });

  it("rejects paths, unidentified focus, and unknown fields at the request boundary", async () => {
    const seam = ports();
    const route = handlers(seam);
    const rejected = await route.discussCreatureProjectSession(
      post({
        requestId: input.requestId,
        text: input.text,
      }),
      params,
    );
    expect(rejected.status).toBe(400);
    expect(
      (await route.startCreatureProjectThread(post({ ...input, cwd: "C:/private" }), params))
        .status,
    ).toBe(400);
    expect(
      (
        await route.receiveCreatureProjectWork(
          post({
            ...input,
            creature: "pip",
            project: params.project,
          }),
          params,
        )
      ).status,
    ).toBe(400);
    expect(seam.creatureProjects.run).not.toHaveBeenCalled();
    expect(seam.creatureProjects.discuss).not.toHaveBeenCalled();
    expect(seam.creatureProjectWork.start).not.toHaveBeenCalled();
  });

  it("gives the receiver a qualified request and returns its current authorization refusal", async () => {
    const seam = ports();
    const route = handlers(seam);
    const request = {
      ...input,
      creature: { workspace: "managed-home", slug: "pip" },
      project: params.project,
    };
    seam.creatureProjectWork.start.mockRejectedValueOnce(
      new CreatureProjectError("untrusted-project"),
    );
    const rejected = await route.receiveCreatureProjectWork(post(request), params);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "untrusted-project" });
    const accepted = await route.receiveCreatureProjectWork(post(request), params);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ session: projectSession });
    expect(seam.creatureProjectWork.start.mock.calls).toEqual([[request], [request]]);
  });
});
