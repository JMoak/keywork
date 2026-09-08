import { engineEventTypes } from "./events.ts";

export type HttpMethod = "GET" | "POST";

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  authenticated: boolean;
  requestBody?: JsonSchema;
  responses: Readonly<Record<string, string>>;
}

export type JsonSchema = Record<string, unknown>;

export interface WorkspaceInfo {
  anchor: string;
  identity: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string; workspace?: WorkspaceInfo };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<Lowercase<HttpMethod>, OpenApiOperation>>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, JsonSchema>;
  };
  security: Array<Record<string, string[]>>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  parameters?: JsonSchema[];
  requestBody?: { required: true; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
  security?: Array<Record<string, string[]>>;
}

const promptBody: JsonSchema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const askAnswerBody: JsonSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["granted", "denied"] } },
  additionalProperties: false,
};

export const routes = [
  {
    method: "GET",
    path: "/doc",
    operationId: "getDocument",
    summary: "This OpenAPI 3.1 document.",
    authenticated: false,
    responses: { "200": "The document." },
  },
  {
    method: "GET",
    path: "/events",
    operationId: "streamEvents",
    summary:
      "Server-sent events: every bus envelope as `event: <type>` plus `data: <envelope json>`. Send `Last-Event-ID` to resume from a retained id (0 replays everything still retained); without it the stream starts live.",
    authenticated: true,
    responses: { "200": "An open text/event-stream." },
  },
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
      "Append a user prompt and run a turn. When the policy would ask, a `gate.ask` event names the call and the turn waits on POST /asks/{callId}; an unanswered ask times out as a headless denial. Progress arrives on /events.",
    authenticated: true,
    requestBody: promptBody,
    responses: {
      "202": "The prompt was accepted; watch /events for the turn.",
      "400": "The body is not `{ text }`.",
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
    path: "/asks",
    operationId: "listAsks",
    summary: "Tool calls waiting on a person: every unanswered `gate.ask`, oldest first.",
    authenticated: true,
    responses: { "200": "The pending asks." },
  },
  {
    method: "POST",
    path: "/asks/{callId}",
    operationId: "answerAsk",
    summary:
      'Answer a pending ask. The turn resumes with the verdict and reports it as `gate.permission` with `gate: "user"`.',
    authenticated: true,
    requestBody: askAnswerBody,
    responses: {
      "200": "The ask was settled.",
      "400": 'The body is not `{ verdict: "granted" | "denied" }`.',
      "404": "No ask with that callId is pending.",
      "409": "That ask was already answered or timed out.",
    },
  },
] as const satisfies readonly RouteSpec[];

export type Route = (typeof routes)[number];

export type OperationId = Route["operationId"];

export function openApiDocument(
  serverUrl: string,
  version: string,
  workspace?: WorkspaceInfo,
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const route of routes) {
    const item = paths[route.path] ?? {};
    item[route.method.toLowerCase() as Lowercase<HttpMethod>] = operationOf(route);
    paths[route.path] = item;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "keywork",
      version,
      description:
        "The keywork workspace server: the in-process event bus over HTTP and SSE. Bound to 127.0.0.1 with a per-launch bearer token.",
      ...(workspace !== undefined && { workspace }),
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: { BusEnvelope: envelopeSchema, Error: errorSchema },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearer: [] }],
  };
}

const envelopeSchema: JsonSchema = {
  type: "object",
  required: ["id", "ts", "sessionId", "type", "payload"],
  properties: {
    id: { type: "integer", minimum: 1 },
    ts: { type: "string", format: "date-time" },
    sessionId: { type: "string" },
    type: { type: "string", enum: [...engineEventTypes] },
    payload: {},
  },
};

const errorSchema: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
};

function operationOf(route: RouteSpec): OpenApiOperation {
  const responses: OpenApiOperation["responses"] = {};
  for (const [status, description] of Object.entries(route.responses)) {
    responses[status] = { description };
  }
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(pathParametersOf(route.path).length > 0 && { parameters: pathParametersOf(route.path) }),
    ...(route.requestBody !== undefined && {
      requestBody: {
        required: true,
        content: { "application/json": { schema: route.requestBody } },
      },
    }),
    responses,
    ...(!route.authenticated && { security: [] }),
  };
}

function pathParametersOf(path: string): JsonSchema[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}
