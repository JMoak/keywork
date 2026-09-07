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

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
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
    summary: "One session with its messages.",
    authenticated: true,
    responses: { "200": "The session.", "404": "No session has that id." },
  },
  {
    method: "POST",
    path: "/sessions/{id}/prompt",
    operationId: "promptSession",
    summary:
      "Append a user prompt and run a turn. The turn runs headless: any `ask` gate answers no and is reported as a `gate.permission` event. Progress arrives on /events.",
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
] as const satisfies readonly RouteSpec[];

export type Route = (typeof routes)[number];

export type OperationId = Route["operationId"];

export function openApiDocument(serverUrl: string, version: string): OpenApiDocument {
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
    ...(route.path.includes("{id}") && { parameters: [sessionIdParameter] }),
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

const sessionIdParameter: JsonSchema = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
};
