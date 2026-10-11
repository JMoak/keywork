import type { SendBehavior } from "@keywork/engine";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const promptBody: JsonSchema = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1 },
    behavior: { type: "string", enum: ["steer", "queue"], default: "queue" },
  },
  additionalProperties: false,
};

const clientName = /^[A-Za-z0-9._-]{1,64}$/;

const injectBody: JsonSchema = {
  type: "object",
  required: ["text", "client"],
  properties: {
    text: { type: "string", minLength: 1 },
    client: { type: "string", pattern: clientName.source },
  },
  additionalProperties: false,
};

export const sessionRoutes = [
  {
    method: "GET",
    path: "/sessions",
    operationId: "listSessions",
    summary: "Session summaries, newest first.",
    authenticated: true,
    responses: { "200": "The summaries." },
  },
  {
    method: "POST",
    path: "/sessions",
    operationId: "createSession",
    summary: "Create an empty session in this workspace.",
    authenticated: true,
    responses: { "201": "The new session's summary." },
  },
  {
    method: "GET",
    path: "/sessions/{id}",
    operationId: "readSession",
    summary:
      "One session with its messages. `asOf` is the latest /events id the messages already reflect, so a client that opened the stream first can drop buffered envelopes with `id <= asOf`.",
    authenticated: true,
    responses: { "200": "The session.", "404": "No session has that id." },
  },
  {
    method: "POST",
    path: "/sessions/{id}/prompt",
    operationId: "promptSession",
    summary:
      "Append a user prompt and run a turn. `behavior` defaults to `queue`: when a turn is already running the prompt waits behind it, which is what Enter does in the terminal composer. `steer` interrupts the running turn and runs this prompt before anything queued. When the policy would ask, a `gate.ask` event names the call and the turn waits on POST /asks/{callId}; an unanswered ask times out as a headless denial. Progress arrives on /events and a `session.state` envelope follows acceptance.",
    authenticated: true,
    requestBody: promptBody,
    responses: {
      "202":
        "The prompt was accepted; `queued` says whether it waits behind a running turn. Watch /events for the turn.",
      "400": 'The body is not `{ text, behavior?: "steer" | "queue" }`.',
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/inject",
    operationId: "injectPrompt",
    summary:
      'Submit a prompt from a client outside keywork, such as a voice assistant or another LLM window. It runs exactly like a typed prompt: it starts a turn when the session is idle and joins the back of the queue when a turn is running. `turn.started` and `queue.changed` carry `origin: { kind: "external", client }`, the turn answers to the same permission policy and ask queue, and any memory note it proposes is staged with provenance `untrusted`.',
    authenticated: true,
    requestBody: injectBody,
    responses: {
      "202": "The prompt was accepted; `queued` is true when it waits behind a running turn.",
      "400": "The body is not `{ text, client }`.",
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/abort",
    operationId: "abortSession",
    summary: "Interrupt the session's running turn, if any.",
    authenticated: true,
    responses: {
      "200": "Whether a turn was interrupted.",
      "404": "No session has that id.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const sessionFamily = {
  routes: sessionRoutes,
  handlers: ({ host }) => ({
    listSessions: async () => json(200, { sessions: await host.list() }),
    createSession: async () => json(201, await host.create()),
    readSession: async (_request, { id }) => {
      const session = await host.read(id ?? "");
      return session === undefined ? missingSession() : json(200, session);
    },
    promptSession: async (request, { id }) => {
      const prompt = promptOf(await bodyOf(request));
      if (prompt === undefined) {
        return json(400, {
          error: 'the body must be { text: string, behavior?: "steer" | "queue" }',
        });
      }
      const outcome = await host.prompt(id ?? "", prompt.text, prompt.behavior);
      return outcome === "missing"
        ? missingSession()
        : json(202, {
            sessionId: id,
            accepted: true,
            queued: outcome === "queued",
            behavior: prompt.behavior,
          });
    },
    injectPrompt: async (request, { id }) => {
      const injection = injectionOf(await bodyOf(request));
      if (injection === undefined) {
        return json(400, { error: "the body must be { text: string, client: string }" });
      }
      const origin = { kind: "external", client: injection.client } as const;
      const outcome = await host.inject(id ?? "", injection.text, origin);
      return outcome === "missing"
        ? missingSession()
        : json(202, { sessionId: id, accepted: true, queued: outcome === "queued" });
    },
    abortSession: async (_request, { id }) => {
      const outcome = await host.abort(id ?? "");
      return outcome === "missing"
        ? missingSession()
        : json(200, { sessionId: id, interrupted: outcome === "aborted" });
    },
  }),
} satisfies RouteFamily<typeof sessionRoutes>;

function promptOf(body: unknown): { text: string; behavior: SendBehavior } | undefined {
  const fields = fieldsOf<{ text: unknown; behavior: unknown }>(body);
  const text = nonBlank(fields?.text);
  const behavior = fields?.behavior ?? "queue";
  if (text === undefined || (behavior !== "steer" && behavior !== "queue")) return undefined;
  return { text, behavior };
}

function injectionOf(body: unknown): { text: string; client: string } | undefined {
  const fields = fieldsOf<{ text: unknown; client: unknown }>(body);
  const text = nonBlank(fields?.text);
  const client = fields?.client;
  if (text === undefined || typeof client !== "string" || !clientName.test(client))
    return undefined;
  return { text, client };
}
