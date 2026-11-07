import { json } from "../routes/family.ts";
import type { MeshCaller, MeshHandler } from "./engine-mesh.ts";

export type MeshMethod = "GET" | "POST" | "PUT" | "DELETE";

export type MeshParams = Readonly<Record<string, string>>;

export interface MeshRoute {
  method: MeshMethod;
  path: string;
  handle(request: Request, caller: MeshCaller, params: MeshParams): Promise<Response>;
}

export function meshRouter(routes: readonly MeshRoute[]): MeshHandler {
  const table = compile(routes);
  return async (request, caller) => {
    const { pathname } = new URL(request.url);
    const matches = table.filter(({ pattern }) => pattern.test(pathname));
    if (matches.length === 0) return json(404, { error: "mesh.not-found" });
    const match = matches.find(({ route }) => route.method === request.method);
    if (match === undefined) {
      const response = json(405, { error: "mesh.method-not-allowed" });
      response.headers.set("allow", matches.map(({ route }) => route.method).join(", "));
      return response;
    }
    try {
      return await match.route.handle(request, caller, paramsOf(match.pattern, pathname));
    } catch {
      return json(500, { error: "mesh.failed" });
    }
  };
}

interface CompiledRoute {
  route: MeshRoute;
  pattern: RegExp;
}

function compile(routes: readonly MeshRoute[]): CompiledRoute[] {
  const seen = new Set<string>();
  return routes.map((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`two mesh routes claim ${key}`);
    seen.add(key);
    return { route, pattern: patternOf(route.path) };
  });
}

function patternOf(path: string): RegExp {
  const source = path.replace(/\{(\w+)\}/g, (_match, name: string) => `(?<${name}>[^/]+)`);
  return new RegExp(`^${source}/?$`);
}

function paramsOf(pattern: RegExp, pathname: string): MeshParams {
  const groups = pattern.exec(pathname)?.groups ?? {};
  return Object.fromEntries(
    Object.entries(groups).map(([name, value]) => [name, decodeURIComponent(value)]),
  );
}
