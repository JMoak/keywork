import type { SendBehavior } from "@keywork/engine";
import { maxFileSliceBytes } from "../host.ts";
import {
  bodyOf,
  byteRangeOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  queryOf,
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
      "Append a user prompt and run a turn. `behavior` says what to do when a turn is already running: `queue` (the default) waits its turn behind the running one; `steer` interrupts the running turn and runs next, ahead of anything queued. When the policy would ask, a `gate.ask` event names the call and the turn waits on POST /asks/{callId}; an unanswered ask times out as a headless denial. Progress arrives on /events.",
    authenticated: true,
    requestBody: promptBody,
    responses: {
      "202": "The prompt was accepted; `queued` is true when it waits behind a running turn.",
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
  {
    method: "GET",
    path: "/sessions/{id}/spills/{spillId}",
    operationId: "readSpill",
    summary: `A byte range of one tool output the session spilled to disk, as UTF-8 text: \`[from, to)\`, default the whole spill, at most ${maxFileSliceBytes} bytes per request. The answer is GET /files's slice with \`spillId\` in place of \`path\`: \`{ spillId, bytes, from, to, text, truncated, eof, encoding }\` (\`truncated: true\` when the range was cut to fit; \`eof: true\` when \`to\` reached the end). A tool result's \`spill\` reference carries \`id\`, \`bytes\`, \`elidedFrom\` and \`elidedTo\`; \`from=elidedFrom&to=elidedTo\` opens exactly the region the transcript elided. Spills live beside the session's JSONL, so a stored session that is not live answers too.`,
    authenticated: true,
    responses: {
      "200": "The slice.",
      "400": "`from` or `to` is not a whole number.",
      "404": "No session has that id, or the session kept no spill with that id.",
      "415": "The slice holds a NUL byte, so the spill is treated as binary.",
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
    readSpill: async (request, { id, spillId }) => {
      const range = byteRangeOf(queryOf(request));
      if (range === "invalid") return json(400, { error: "from and to must be whole numbers" });
      const slice = await host.spill(id ?? "", spillId ?? "", range);
      return slice === "missing" ? missingSession() : json(200, slice);
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
