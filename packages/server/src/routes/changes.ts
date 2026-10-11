import { json, missingSession, type RouteFamily, type RouteSpec } from "./family.ts";

export const changeRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/changes",
    operationId: "readChanges",
    summary:
      "Files the session has changed since its first checkpoint: each with `added` and `deleted` line counts and `turn`, the 1-based turn that last touched it. An untrusted workspace answers `trusted: false` with no files.",
    authenticated: true,
    responses: {
      "200": "The changed files.",
      "404": "No session has that id.",
      "409": "No baseline: checkpoints are off for this workspace.",
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/changes/file",
    operationId: "readChangedFile",
    summary:
      "One changed file's text at the baseline (`before`) and now (`after`), each capped at 1 MiB with `truncated: true` past it; `path` is a query parameter relative to the workspace. `note` says `new`, `deleted`, `binary` (no text is sent) or `unreadable`.",
    authenticated: true,
    responses: {
      "200": "Both sides of the file.",
      "400": "`path` is missing, absolute, or escapes the workspace.",
      "404": "No session has that id.",
      "409": "No baseline: checkpoints are off for this workspace.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const changeFamily = {
  routes: changeRoutes,
  handlers: ({ host }) => ({
    readChanges: async (_request, { id }) => {
      const outcome = await host.changes(id ?? "");
      if (outcome === "missing") return missingSession();
      if (outcome === "untrusted") return json(200, { trusted: false, files: [] });
      if (outcome === "no-baseline") return noBaseline();
      return json(200, { trusted: true, ...outcome });
    },
    readChangedFile: async (request, { id }) => {
      const path = workspacePathOf(new URL(request.url).searchParams.get("path"));
      if (path === undefined) {
        return json(400, { error: "path must be a relative path inside the workspace" });
      }
      const outcome = await host.changedFile(id ?? "", path);
      if (outcome === "missing") return missingSession();
      if (outcome === "untrusted") {
        return json(200, { trusted: false, path, before: null, after: null, truncated: false });
      }
      if (outcome === "no-baseline") return noBaseline();
      return json(200, { trusted: true, ...outcome });
    },
  }),
} satisfies RouteFamily<typeof changeRoutes>;

function noBaseline(): Response {
  return json(409, { error: "no baseline" });
}

function workspacePathOf(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  const segments = raw.replaceAll("\\", "/").split("/");
  const escapes = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  return escapes || /^[A-Za-z]:/.test(raw) ? undefined : segments.join("/");
}
