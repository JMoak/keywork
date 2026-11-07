import type { RunRow } from "./run.ts";
import type { HookDelivery, Missing, Refusal, RoutineService } from "./service.ts";

export interface RoutineRequest {
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  body: unknown;
  hook?: HookDelivery;
}

export interface RoutineReply {
  status: number;
  body: unknown;
}

export type RoutineOperation = (
  service: RoutineService,
  request: RoutineRequest,
) => Promise<RoutineReply>;

export const defaultRunsLimit = 50;
export const largestRunsLimit = 500;

export const routineOperations = {
  listRoutines: async (service, { params }) =>
    replyOf(await service.list(slugOf(params)), (routines) => ok({ routines })),
  readRoutine: async (service, { params }) =>
    replyOf(await service.read(slugOf(params), idOf(params)), (routine) => ok({ routine })),
  putRoutine: async (service, { params, body }) =>
    replyOf(await service.put(slugOf(params), idOf(params), body), ({ routine, created }) => ({
      status: created ? 201 : 200,
      body: { routine, created },
    })),
  deleteRoutine: async (service, { params }) =>
    replyOf(await service.remove(slugOf(params), idOf(params)), (removed) => ok({ removed })),
  runRoutine: async (service, { params }) =>
    replyOf(await service.run(slugOf(params), idOf(params)), (run) => ({
      status: statusOfFiredRun(run),
      body: { run },
    })),
  cancelRoutine: async (service, { params }) =>
    replyOf(await service.cancel(slugOf(params), idOf(params)), (run) =>
      run === "idle"
        ? { status: 409, body: { error: "the chore has no run in progress" } }
        : { status: 202, body: { run } },
    ),
  listRoutineRuns: async (service, { params, query }) => {
    const limit = limitOf(query.get("limit"));
    if (limit === undefined) {
      return badRequest(`limit must be an integer from 1 to ${largestRunsLimit}`);
    }
    return replyOf(await service.runs(slugOf(params), idOf(params), limit), (runs) => ok({ runs }));
  },
  acceptRoutineGrants: async (service, { params, body }) => {
    const digest = digestOf(body);
    if (digest === undefined) return badRequest("the body must be { digest: string }");
    return replyOf(await service.accept(slugOf(params), idOf(params), digest), (routine) =>
      ok({ routine }),
    );
  },
  listNeedsYou: async (service) => ok({ items: service.needsYou() }),
  mintRoutineHook: async (service, { params }) =>
    replyOf(await service.mintHook(slugOf(params), idOf(params)), (hook) => ok(hook)),
  fireRoutineHook: async (service, { params, hook }) => {
    if (hook === undefined) return badRequest("the hook carries no delivery");
    const outcome = await service.hook(slugOf(params), idOf(params), hook);
    if (outcome === "unauthorized")
      return { status: 401, body: { error: "no hook answers that token" } };
    if (outcome === "too-large")
      return { status: 413, body: { error: "the body is larger than this hook takes" } };
    if (isRefusal(outcome)) return { status: 409, body: { error: outcome.refusal } };
    return {
      status: statusOfFiredRun(outcome),
      body: { runId: outcome.runId, status: outcome.status },
    };
  },
} satisfies Record<string, RoutineOperation>;

export type RoutineOperationId = keyof typeof routineOperations;

function replyOf<Value>(
  outcome: Value | Missing | Refusal,
  success: (value: Value) => RoutineReply,
): RoutineReply {
  if (outcome === "missing-creature") return notFound("no creature has that slug");
  if (outcome === "missing-routine") return notFound("that creature has no chore with that id");
  if (isRefusal(outcome)) return badRequest(outcome.refusal);
  return success(outcome as Value);
}

function statusOfFiredRun(run: RunRow): number {
  if (run.status === "skipped" || run.status === "dropped") return 409;
  return run.status === "running" ? 202 : 200;
}

function isRefusal(outcome: unknown): outcome is Refusal {
  return typeof outcome === "object" && outcome !== null && "refusal" in outcome;
}

function ok(body: unknown): RoutineReply {
  return { status: 200, body };
}

function notFound(error: string): RoutineReply {
  return { status: 404, body: { error } };
}

function badRequest(error: string): RoutineReply {
  return { status: 400, body: { error } };
}

function slugOf(params: RoutineRequest["params"]): string {
  return params.slug ?? "";
}

function idOf(params: RoutineRequest["params"]): string {
  return params.id ?? "";
}

function limitOf(text: string | null): number | undefined {
  if (text === null) return defaultRunsLimit;
  const limit = Number(text);
  return /^\d+$/.test(text) && limit >= 1 && limit <= largestRunsLimit ? limit : undefined;
}

function digestOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("digest" in body)) return undefined;
  return typeof body.digest === "string" && body.digest !== "" ? body.digest : undefined;
}
