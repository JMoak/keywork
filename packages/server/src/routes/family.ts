import type { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import type { OpenApiDocument } from "../openapi.ts";
import type { StreamRegistry } from "../sse.ts";

export type HttpMethod = "GET" | "POST";

export type JsonSchema = Record<string, unknown>;

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  authenticated: boolean;
  requestBody?: JsonSchema;
  responses: Readonly<Record<string, string>>;
}

export interface WorkspaceInfo {
  anchor: string;
  identity: string;
}

export interface RouteContext {
  host: SessionHost;
  log: EventLog;
  streams: StreamRegistry;
  describe(): OpenApiDocument;
}

export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler = (request: Request, params: RouteParams) => Promise<Response>;

export type HandlersOf<Routes extends readonly RouteSpec[]> = Record<
  Routes[number]["operationId"],
  RouteHandler
>;

export interface RouteFamily<Routes extends readonly RouteSpec[] = readonly RouteSpec[]> {
  routes: Routes;
  handlers(context: RouteContext): HandlersOf<Routes>;
}

export type OperationIdOf<Families extends readonly RouteFamily[]> =
  Families[number]["routes"][number]["operationId"];

export function handlersOf<Families extends readonly RouteFamily[]>(
  families: Families,
  context: RouteContext,
): Record<OperationIdOf<Families>, RouteHandler> {
  const merged: Record<string, RouteHandler> = {};
  for (const family of families) Object.assign(merged, family.handlers(context));
  return merged as Record<OperationIdOf<Families>, RouteHandler>;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function unauthorized(): Response {
  return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

export function missingSession(): Response {
  return json(404, { error: "no session has that id" });
}

export async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function fieldsOf<Shape extends Record<string, unknown>>(
  body: unknown,
): Partial<Record<keyof Shape, unknown>> | undefined {
  return typeof body === "object" && body !== null
    ? (body as Partial<Record<keyof Shape, unknown>>)
    : undefined;
}

export function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
