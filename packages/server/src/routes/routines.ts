import {
  largestHookBytes,
  type RoutineOperationId,
  type RoutineService,
  routineJsonSchema,
  routineOperations,
} from "@keywork/engine";
import { servedBy } from "./answers.ts";
import {
  bodyOf,
  type HandlersOf,
  type JsonSchema,
  json,
  type RouteContext,
  type RouteFamily,
  type RouteHandler,
  type RouteSpec,
} from "./family.ts";

type RoutineRouteSpec = RouteSpec & { operationId: RoutineOperationId };

const acceptBody: JsonSchema = {
  type: "object",
  required: ["digest"],
  properties: { digest: { type: "string" } },
};

const routineRow =
  "`{ creature, id, file, routine, problem, grants: { posture, digest, needsAcceptance, accepted, acceptedAt }, schedule: { enabled, disabled, nextRunAt, consecutiveErrors, retryAt }, activeRunId, lastRun }`";

const runRow =
  "`{ runId, creature, routineId, attempt, trigger, catchUp, firedAt, scheduledFor, status, sessionId, startedAt, endedAt, process, delivery, verified, reason, usage, cost, output, notify }`";

const missing = "No creature has that slug, or it has no chore with that id.";

export const routineRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/routines",
    operationId: "listRoutines",
    summary: `The creature's chores, read again from its \`routines/<id>.json\` files (the files are the source; the node's SQLite journal is the index). Each row is ${routineRow}: \`routine\` is null and \`problem\` says why when a file does not parse; \`schedule.nextRunAt\` is the next planned start including the routine's deterministic stagger; \`schedule.disabled\` carries the reason when repeated failures turned the chore off.`,
    authenticated: true,
    responses: { "200": "`{ routines }`.", "404": "No creature has that slug." },
  },
  {
    method: "GET",
    path: "/creatures/{slug}/routines/{id}",
    operationId: "readRoutine",
    summary: `One chore as ${routineRow}.`,
    authenticated: true,
    responses: { "200": "`{ routine }`.", "404": missing },
  },
  {
    method: "PUT",
    path: "/creatures/{slug}/routines/{id}",
    operationId: "putRoutine",
    summary:
      "Write the chore's file and index it. The body is the routine file (`id` may be left out; the path names it). Triggers are `cron` (with an IANA `tz` and an optional `until`), `interval` (with an optional `until` instant), `at` (one instant), `file-watch` (paths or globs under the workspace, debounced), `webhook` (fired through `POST /hooks/{slug}/{id}` with the chore's token) and `event` (a bus event by name, with a `where` filter), and `manual`; since contract 1.17 for the last four beside the first two. A fired trigger is a stored assignment, never consent: every trigger parks the same way on an unaccepted grant set. A chore with `wake` is one the creature asked for itself with the schedule tool; the keeper removes it like any other. `tools` is `read-only` unless the chore declares `write` or `act` with a `grants` set, and the keeper must accept that set once (`POST .../accept`) before such a chore runs; nothing in this body can accept it. Putting a chore that repeated failures disabled back with `enabled: true` reinstates it.",
    authenticated: true,
    requestBody: routineJsonSchema,
    responses: {
      "200": "`{ routine, created: false }`: the chore was replaced.",
      "201": "`{ routine, created: true }`: the chore is new.",
      "400": "The body is not a valid routine, or its id differs from the path.",
      "404": "No creature has that slug.",
    },
  },
  {
    method: "DELETE",
    path: "/creatures/{slug}/routines/{id}",
    operationId: "deleteRoutine",
    summary:
      "Remove the chore's file and its schedule. Its run journal stays. A run in progress is not stopped by this verb; `POST .../cancel` stops work.",
    authenticated: true,
    responses: { "200": "`{ removed }`: the chore as it was.", "404": missing },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/routines/{id}/run",
    operationId: "runRoutine",
    summary: `Run the chore now, by hand. A run by hand grants nothing: a write or act chore without an accepted grant set parks at once (\`status: parked\`, no session, \`reason\` saying why) and proceeds the moment the keeper accepts that grant set; until then it is the chore's one needs-you item. A run still in progress or parked refuses the new one, which is recorded as \`skipped\`. Answers ${runRow}; \`routine.fired\` and \`routine.finished\` follow on the event stream.`,
    authenticated: true,
    responses: {
      "202": "`{ run }`: the run started.",
      "200":
        "`{ run }`: the run did not start: parked on its grant set until the keeper accepts, or failed at once.",
      "400": "The chore's file does not parse.",
      "404": missing,
      "409": "`{ run }`: a run is still in progress, so this one was recorded as skipped.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/routines/{id}/cancel",
    operationId: "cancelRoutine",
    summary:
      "Stop the chore's run in progress. Its schedule is untouched (cancelling a schedule is `PUT` with `enabled: false`), and stopping does not undo what the run already did. The run ends as `cancelled` and `routine.finished` follows.",
    authenticated: true,
    responses: {
      "202": "`{ run }`: the stop was requested.",
      "404": missing,
      "409": "The chore has no run in progress.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/routines/{id}/accept",
    operationId: "acceptRoutineGrants",
    summary:
      "The keeper accepts a write or act chore's declared grant set, named by the `digest` its row shows, so the keeper accepts exactly what they read. A changed file changes the digest and voids the acceptance; a fired trigger, a run by hand or a routine body never accepts.",
    authenticated: true,
    requestBody: acceptBody,
    responses: {
      "200": "`{ routine }` with `grants.accepted: true`.",
      "400": "The body is not `{ digest }`, the digest is stale, or the chore is read-only.",
      "404": missing,
    },
  },
  {
    method: "GET",
    path: "/creatures/{slug}/routines/{id}/runs",
    operationId: "listRoutineRuns",
    summary: `The chore's run journal, newest first, as ${runRow}. \`process\` (completed, failed, cancelled, timed-out, blocked), \`delivery\` (delivered, unknown, failed, none) and \`verified\` are separate on purpose: a run that ended is not a result that arrived. Skipped and dropped slots are rows too, each with its reason. \`?limit=\` takes 1 to 500 (default 50).`,
    authenticated: true,
    responses: {
      "200": "`{ runs }`.",
      "400": "The limit is not an integer from 1 to 500.",
      "404": missing,
    },
  },
  {
    method: "GET",
    path: "/routines/needs-you",
    operationId: "listNeedsYou",
    summary:
      "Every chore that needs the keeper, across creatures, from one source: `{ items }`, each `{ creature, routineId, kind, reason, runId, since, action }`. `kind` is `grants` (a write or act chore held on an unaccepted grant set; `action` is `{ verb: accept, digest }` and `runId` names the run that was refused, when one was), `run` (the last run ended and needs you: failed, timed out, over budget or blocked), `disabled` (repeated failures turned the chore off) or `invalid` (its file does not parse). `since` is when that began, when known. A held run has no session, so the item carries the chore, never a thread. `routine.needs` on the event stream carries the same items per chore whenever they change, empty once the chore no longer needs you. Since contract 1.10.",
    authenticated: true,
    responses: { "200": "`{ items }`." },
  },
] as const satisfies readonly RoutineRouteSpec[];

export const routineHookRoutes = [
  {
    method: "POST",
    path: "/creatures/{slug}/routines/{id}/hook",
    operationId: "mintRoutineHook",
    summary:
      "Mint the token a `webhook` chore answers to, replacing any earlier one. The answer is the only time the token is shown; the node keeps its digest. Removing the chore removes the token. Since contract 1.17.",
    authenticated: true,
    responses: {
      "200": "`{ token, path }`: the bearer token and the hook's path (`/hooks/{slug}/{id}`).",
      "400": "The chore's trigger is not `webhook`, or its file does not parse.",
      "404": missing,
    },
  },
  {
    method: "POST",
    path: "/hooks/{slug}/{id}",
    operationId: "fireRoutineHook",
    summary:
      "Fire a `webhook` chore. The node serves this on loopback only, and the caller proves itself with the chore's own token (`authorization: Bearer <token>` from `POST .../hook`), never the node's. The body is untrusted data: it is saved as a file beside the run journal and the run's prompt names that file, never its text. A body over the chore's `maxBytes` (at most 1 MiB) is refused. The run obeys the same hourly caps, lock and grant-set park as every trigger. Since contract 1.17.",
    authenticated: false,
    responses: {
      "202": "`{ runId, status }`: the run started.",
      "200":
        "`{ runId, status }`: the run did not start: parked on its grant set, or failed at once.",
      "401": "No hook answers that token (or that chore has none).",
      "409":
        "The chore is turned off, or `{ runId, status }` for a run turned away by a cap or the lock.",
      "413": "The body is larger than the hook takes.",
    },
  },
] as const satisfies readonly RoutineRouteSpec[];

const routineFamilyRoutes = [...routineRoutes, ...routineHookRoutes] as const;

export function registerRoutineRoutes(
  routinesOf: (context: RouteContext) => RoutineService | undefined,
): RouteFamily<typeof routineFamilyRoutes> {
  return {
    routes: routineFamilyRoutes,
    handlers: (context) => {
      const served = servedBy(() => routinesOf(context), "chores");
      const handlers = {} as HandlersOf<typeof routineFamilyRoutes> & Record<string, RouteHandler>;
      for (const { operationId } of [...routineRoutes, routineHookRoutes[0]]) {
        handlers[operationId] = served(async (service, request, params) => {
          const reply = await routineOperations[operationId](service, {
            params,
            query: new URL(request.url).searchParams,
            body: await bodyOf(request),
          });
          return json(reply.status, reply.body);
        });
      }
      handlers.fireRoutineHook = served(async (service, request, params) => {
        const body = await cappedText(request, largestHookBytes);
        if (body === undefined)
          return json(413, { error: "the body is larger than any hook takes" });
        const reply = await routineOperations.fireRoutineHook(service, {
          params,
          query: new URL(request.url).searchParams,
          body: undefined,
          hook: {
            token: bearerOf(request),
            contentType: request.headers.get("content-type") ?? "",
            body,
          },
        });
        return json(reply.status, reply.body);
      });
      return handlers;
    },
  };
}

async function cappedText(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined;
  if (request.body === null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body) {
    total += chunk.byteLength;
    if (total > limit) return undefined;
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function bearerOf(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}
