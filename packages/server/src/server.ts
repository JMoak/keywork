import { toError } from "@keywork/shared";
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
import { nothingWoundDown, type WoundDown } from "./routes/work.ts";
import { bearerMatches } from "./token.ts";

export const defaultPort = 4770;

export interface ServerOptions {
  token: string;
  host: SessionHost;
  log: EventLog;
  version: string;
  url?: string;
  workspace?: WorkspaceInfo;
  stop?: () => void;
  notice?: ((line: string) => void) | undefined;
}

export interface KeyworkServer {
  fetch(request: Request): Promise<Response>;
  rehost(host: SessionHost): Promise<void>;
  close(): Promise<void>;
}

export function createKeyworkServer(options: ServerOptions): KeyworkServer {
  const streams = new OpenStreams();
  const url = options.url ?? `http://127.0.0.1:${defaultPort}`;
  let host = options.host;
  let shutdown: Promise<WoundDown> | undefined;
  const windDown = async (): Promise<WoundDown> =>
    (await host.work?.windDown()) ?? nothingWoundDown;
  const stop = options.stop;
  const shutDown =
    stop === undefined
      ? undefined
      : () => {
          shutdown ??= windDown().then((report) => {
            setTimeout(stop, 0);
            return report;
          });
          return shutdown;
        };
  const handlersFor = (served: SessionHost) =>
    handlersOf(routeFamilies, {
      host: served,
      log: options.log,
      streams,
      describe: () => openApiDocument(url, options.version, options.workspace),
      ...(shutDown !== undefined && { shutDown }),
    });
  let handlers = handlersFor(host);
  return {
    fetch: async (request) => {
      const match = matchRoute(request);
      if (match === undefined) return json(404, { error: "no such route" });
      if (match.route.authenticated && !bearerMatches(request, options.token))
        return unauthorized();
      if (shutdown !== undefined && startsWork(match.route)) {
        return json(503, { error: "this server is shutting down" });
      }
      try {
        return await handlers[match.route.operationId](request, match.params);
      } catch (cause) {
        noticeOf(options)(`${routeWords(request, match.route)} failed: ${faultWords(cause)}`);
        return json(500, { error: `internal fault: ${toError(cause).message}` });
      }
    },
    rehost: async (next) => {
      const previous = host;
      host = next;
      handlers = handlersFor(next);
      await previous.close();
    },
    close: async () => {
      await windDown();
      streams.closeAll();
      await host.close();
    },
  };
}

function startsWork(route: Route): boolean {
  return route.method !== "GET" && route.operationId !== "shutDown";
}

export function noticeOf(options: Pick<ServerOptions, "notice">): (line: string) => void {
  return options.notice ?? ((line) => process.stderr.write(`${line}\n`));
}

export function faultWords(cause: unknown): string {
  const error = toError(cause);
  return error.stack ?? error.message;
}

function routeWords(request: Request, route: Route): string {
  return `${request.method} ${new URL(request.url).pathname} (${route.operationId})`;
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
