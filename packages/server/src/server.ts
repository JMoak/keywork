import type { AskVerdict } from "./asks.ts";
import type { EventLog } from "./events.ts";
import type { SessionHost } from "./host.ts";
import {
  type HttpMethod,
  type OperationId,
  openApiDocument,
  type Route,
  routes,
  type WorkspaceInfo,
} from "./openapi.ts";
import { eventStreamResponse } from "./sse.ts";
import { bearerMatches } from "./token.ts";

export const defaultPort = 4770;

export interface ServerOptions {
  token: string;
  host: SessionHost;
  log: EventLog;
  version: string;
  url?: string;
  workspace?: WorkspaceInfo;
}

export interface KeyworkServer {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createKeyworkServer(options: ServerOptions): KeyworkServer {
  const streams = new OpenStreams();
  const url = options.url ?? `http://127.0.0.1:${defaultPort}`;
  const handlers = routeHandlers(options, streams, url);
  return {
    fetch: async (request) => {
      const match = matchRoute(request);
      if (match === undefined) return json(404, { error: "no such route" });
      if (match.route.authenticated && !bearerMatches(request, options.token))
        return unauthorized();
      return handlers[match.route.operationId](request, match.params);
    },
    close: async () => {
      streams.closeAll();
      await options.host.close();
    },
  };
}

type RouteHandler = (
  request: Request,
  params: Readonly<Record<string, string>>,
) => Promise<Response>;

function routeHandlers(
  options: ServerOptions,
  streams: OpenStreams,
  url: string,
): Record<OperationId, RouteHandler> {
  const { host, log } = options;
  return {
    getDocument: async () => json(200, openApiDocument(url, options.version, options.workspace)),
    streamEvents: async (request) => eventStreamResponse(log, request, streams),
    listSessions: async () => json(200, { sessions: await host.list() }),
    createSession: async () => json(201, await host.create()),
    readSession: async (_request, { id }) => {
      const session = await host.read(id ?? "");
      return session === undefined ? missingSession() : json(200, session);
    },
    promptSession: async (request, { id }) => {
      const text = await promptTextOf(request);
      if (text === undefined) return json(400, { error: "the body must be { text: string }" });
      const outcome = await host.prompt(id ?? "", text);
      return outcome === "missing"
        ? missingSession()
        : json(202, { sessionId: id, accepted: true });
    },
    abortSession: async (_request, { id }) => {
      const outcome = await host.abort(id ?? "");
      return outcome === "missing"
        ? missingSession()
        : json(200, { sessionId: id, interrupted: outcome === "aborted" });
    },
    listAsks: async () => json(200, { asks: await host.asks() }),
    answerAsk: async (request, { callId }) => {
      const verdict = await askVerdictOf(request);
      if (verdict === undefined) {
        return json(400, { error: 'the body must be { verdict: "granted" | "denied" }' });
      }
      const outcome = await host.answerAsk(callId ?? "", verdict);
      if (outcome === "missing") return json(404, { error: "no ask with that callId is pending" });
      if (outcome === "already-settled") {
        return json(409, { error: "that ask was already answered or timed out" });
      }
      return json(200, { callId, settled: true });
    },
  };
}

async function askVerdictOf(request: Request): Promise<AskVerdict | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const verdict = (body as { verdict?: unknown } | null)?.verdict;
  return verdict === "granted" || verdict === "denied" ? verdict : undefined;
}

interface RouteMatch {
  route: Route;
  params: Readonly<Record<string, string>>;
}

const compiledRoutes = routes.map((route) => ({ route, pattern: patternOf(route.path) }));

function matchRoute(request: Request): RouteMatch | undefined {
  const { pathname } = new URL(request.url);
  for (const { route, pattern } of compiledRoutes) {
    if (route.method !== (request.method as HttpMethod)) continue;
    const found = pattern.exec(pathname);
    if (found !== null) return { route, params: found.groups ?? {} };
  }
  return undefined;
}

function patternOf(path: string): RegExp {
  const source = path.replace(/\{(\w+)\}/g, (_match, name: string) => `(?<${name}>[^/]+)`);
  return new RegExp(`^${source}/?$`);
}

async function promptTextOf(request: Request): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const text = (body as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

class OpenStreams {
  private readonly closers = new Set<() => void>();

  add(close: () => void): () => void {
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  closeAll(): void {
    for (const close of [...this.closers]) close();
    this.closers.clear();
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function unauthorized(): Response {
  return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

function missingSession(): Response {
  return json(404, { error: "no session has that id" });
}
