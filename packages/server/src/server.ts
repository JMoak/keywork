import type { EventLog } from "./events.ts";
import type { SessionHost } from "./host.ts";
import {
  type HttpMethod,
  openApiDocument,
  type Route,
  routeFamilies,
  routes,
  type WorkspaceInfo,
} from "./openapi.ts";
import { handlersOf, json, type RouteParams, unauthorized } from "./routes/family.ts";
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
  const handlers = handlersOf(routeFamilies, {
    host: options.host,
    log: options.log,
    streams,
    describe: () => openApiDocument(url, options.version, options.workspace),
  });
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

interface RouteMatch {
  route: Route;
  params: RouteParams;
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
