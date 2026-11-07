import { MockProvider } from "@keywork/engine";
import type { PermissionRule } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import { openApiDocument } from "../openapi.ts";
import { memorySessionHost, sseReader } from "../testing.ts";
import {
  type WorkshopDetailRecord,
  type WorkshopFrame,
  type WorkshopRecord,
  type WorkshopRefusalRecord,
  type WorkshopsPort,
  workshopFamily,
  workshopRoutes,
} from "./workshops.ts";

const pip: WorkshopRecord = {
  id: "pip-0a1b2c",
  creature: "pip",
  substrate: "sbx",
  state: "stopped",
  workdir: "/home/agent/workspace",
  brokers: ["anthropic"],
  limitations: [],
  display: true,
  createdAt: "2026-11-05T09:00:00.000Z",
};

const missing: WorkshopRefusalRecord = { refused: "missing", error: "no workshop has id nope" };

const pipDetail: WorkshopDetailRecord = {
  ...pip,
  workspace: {
    access: "working-copy",
    path: "/home/keeper/project",
    returns: "through the airlock or a pushed branch",
  },
  egress: { policy: "deny-all", enforced: true, rules: [], brokerHosts: ["api.anthropic.com"] },
  resources: {
    cpus: 2,
    memory: "4g",
    disks: { rootGb: 20, dockerGb: 10 },
    measured: {
      disk: { usedBytes: null, sizeBytes: null },
      memory: { usedBytes: null, totalBytes: null },
      unmeasured: ["disk and memory are measured inside the microVM, so only while it runs"],
    },
  },
  refusals: { entries: [], unreported: "no reader yet" },
  terminal: { allowed: true, reason: "its own machine", log: [] },
};

interface Recorded {
  readonly calls: string[];
  readonly grants: PermissionRule[][];
}

function fakePort(frames: readonly WorkshopFrame[] = []): WorkshopsPort & Recorded {
  const calls: string[] = [];
  const grants: PermissionRule[][] = [];
  const known = async <Value>(id: string, value: Value) => (id === pip.id ? value : missing);
  return {
    calls,
    grants,
    list: async () => [pip],
    substrates: async () => ({
      substrates: [
        { kind: "sbx", supported: false, version: null, reason: "not installed", limitations: [] },
        { kind: "host", supported: true, version: null, reason: null, limitations: ["bare"] },
      ],
      preferred: "host",
    }),
    detail: async (id, held = []) => {
      grants.push([...held]);
      return known(id, pipDetail);
    },
    exec: async (id, request, held = []) => {
      grants.push([...held]);
      calls.push(`exec ${JSON.stringify(request)}`);
      if (held.some((rule) => rule.effect === "deny")) {
        return { refused: "forbidden", error: "the keeper's rule says deny" };
      }
      return known(id, { workshop: id, code: 0, stdout: "ok\n", stderr: "", timedOut: false });
    },
    create: async (request) => {
      calls.push(`create ${JSON.stringify(request)}`);
      return (request as { gpu?: boolean }).gpu === true
        ? { refused: "deferred", error: "GPU passthrough is deferred past milestone one" }
        : pip;
    },
    start: (id) => known(id, { ...pip, state: "running" as const }),
    stop: (id) => known(id, pip),
    health: (id) =>
      known(id, { id, substrate: "sbx" as const, health: "up" as const, limitations: [] }),
    remove: async (id, keepDisk) => {
      calls.push(`remove ${id} keepDisk=${keepDisk}`);
      return known(id, { id, keptDisk: keepDisk });
    },
    display: async (id, signal) => {
      if (id !== pip.id) return missing;
      return (async function* () {
        for (const frame of frames) {
          if (signal.aborted) return;
          yield frame;
        }
      })();
    },
  };
}

function handlersFor(port: WorkshopsPort | undefined, workspace: PermissionRule[] = []) {
  const log = new EventLog();
  const base: SessionHost = memorySessionHost({ log, provider: new MockProvider([]) });
  const host: SessionHost = {
    ...base,
    permissions: async () => ({ ...(await base.permissions()), workspace }),
  };
  return workshopFamily(() => port).handlers({
    host,
    log,
    streams: { add: () => () => undefined },
    describe: () => openApiDocument("http://127.0.0.1:4770", "test"),
  });
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:4770${path}`, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
}

describe("the workshop routes", () => {
  it("declare the workshop verbs, the substrates, the detail, the terminal and the display stream", () => {
    expect(workshopRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /workshops",
      "GET /workshops/substrates",
      "POST /workshops",
      "GET /workshops/{id}",
      "POST /workshops/{id}/start",
      "POST /workshops/{id}/stop",
      "GET /workshops/{id}/health",
      "POST /workshops/{id}/exec",
      "DELETE /workshops/{id}",
      "GET /workshops/{id}/display",
    ]);
    expect(workshopRoutes.every((route) => route.authenticated)).toBe(true);
  });

  it("list every workshop", async () => {
    const response = await handlersFor(fakePort()).listWorkshops(request("GET", "/workshops"), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workshops: [pip] });
  });

  it("create from the posted spec and answer 201", async () => {
    const port = fakePort();
    const body = { creature: "pip", substrate: "sbx", brokers: ["anthropic"] };

    const response = await handlersFor(port).createWorkshop(
      request("POST", "/workshops", body),
      {},
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(pip);
    expect(port.calls).toEqual([`create ${JSON.stringify(body)}`]);
  });

  it("map a refusal to its status", async () => {
    const handlers = handlersFor(fakePort());

    const deferred = await handlers.createWorkshop(
      request("POST", "/workshops", { creature: "pip", substrate: "sbx", gpu: true }),
      {},
    );
    const unknown = await handlers.startWorkshop(request("POST", "/workshops/nope/start"), {
      id: "nope",
    });

    expect(deferred.status).toBe(501);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(missing);
  });

  it("start, stop and read health by id", async () => {
    const handlers = handlersFor(fakePort());
    const params = { id: pip.id };

    const started = await handlers.startWorkshop(
      request("POST", `/workshops/${pip.id}/start`),
      params,
    );
    const stopped = await handlers.stopWorkshop(
      request("POST", `/workshops/${pip.id}/stop`),
      params,
    );
    const health = await handlers.workshopHealth(
      request("GET", `/workshops/${pip.id}/health`),
      params,
    );

    expect(await started.json()).toMatchObject({ state: "running" });
    expect(await stopped.json()).toMatchObject({ state: "stopped" });
    expect(await health.json()).toEqual({
      id: pip.id,
      substrate: "sbx",
      health: "up",
      limitations: [],
    });
  });

  it("remove, keeping the disk only when asked", async () => {
    const port = fakePort();
    const handlers = handlersFor(port);
    const params = { id: pip.id };

    await handlers.removeWorkshop(request("DELETE", `/workshops/${pip.id}?keepDisk=true`), params);
    const removed = await handlers.removeWorkshop(
      request("DELETE", `/workshops/${pip.id}`),
      params,
    );

    expect(await removed.json()).toEqual({ id: pip.id, keptDisk: false });
    expect(port.calls).toEqual([
      `remove ${pip.id} keepDisk=true`,
      `remove ${pip.id} keepDisk=false`,
    ]);
  });

  it("stream display frames as server-sent events and say when the display ends", async () => {
    const frames = [
      { png: "AAAA", at: "2026-11-05T09:00:00.000Z" },
      { png: "BBBB", at: "2026-11-05T09:00:01.000Z" },
    ];
    const response = await handlersFor(fakePort(frames)).streamWorkshopDisplay(
      request("GET", `/workshops/${pip.id}/display`),
      { id: pip.id },
    );
    const reader = sseReader(response);

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await reader.next()).toMatchObject({ event: "frame", data: JSON.stringify(frames[0]) });
    expect(await reader.next()).toMatchObject({ event: "frame", data: JSON.stringify(frames[1]) });
    expect(await reader.next()).toMatchObject({ event: "ended", data: "{}" });
  });

  it("refuse a display stream for an unknown workshop", async () => {
    const response = await handlersFor(fakePort()).streamWorkshopDisplay(
      request("GET", "/workshops/nope/display"),
      { id: "nope" },
    );

    expect(response.status).toBe(404);
  });

  it("answer 503 when this host serves no workshops", async () => {
    const response = await handlersFor(undefined).listWorkshops(request("GET", "/workshops"), {});

    expect(response.status).toBe(503);
  });
});

describe("the workshop detail routes", () => {
  it("list the substrates the node supports, ahead of the {id} routes", async () => {
    const response = await handlersFor(fakePort()).listWorkshopSubstrates(
      request("GET", "/workshops/substrates"),
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preferred: "host" });
    const order = workshopRoutes.map((route) => route.path);
    expect(order.indexOf("/workshops/substrates")).toBeLessThan(order.indexOf("/workshops/{id}"));
  });

  it("read one workshop's detail under the keeper's workspace grants", async () => {
    const grant: PermissionRule = { action: "workshop.exec", resource: "pip", effect: "allow" };
    const port = fakePort();
    const handlers = handlersFor(port, [grant]);

    const response = await handlers.readWorkshop(request("GET", `/workshops/${pip.id}`), {
      id: pip.id,
    });
    const unknown = await handlers.readWorkshop(request("GET", "/workshops/nope"), { id: "nope" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(pipDetail);
    expect(port.grants[0]).toEqual([grant]);
    expect(unknown.status).toBe(404);
  });

  it("run a typed command and answer its exit", async () => {
    const port = fakePort();

    const response = await handlersFor(port).execInWorkshop(
      request("POST", `/workshops/${pip.id}/exec`, { command: "ls", cwd: "src" }),
      { id: pip.id },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workshop: pip.id,
      code: 0,
      stdout: "ok\n",
      stderr: "",
      timedOut: false,
    });
    expect(port.calls).toEqual([`exec ${JSON.stringify({ command: "ls", cwd: "src" })}`]);
  });

  it("answer 403 when the keeper's rules refuse the terminal", async () => {
    const deny: PermissionRule = { action: "workshop.exec", resource: "*", effect: "deny" };

    const response = await handlersFor(fakePort(), [deny]).execInWorkshop(
      request("POST", `/workshops/${pip.id}/exec`, { command: "ls" }),
      { id: pip.id },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      refused: "forbidden",
      error: "the keeper's rule says deny",
    });
  });
});
