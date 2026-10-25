import type { ByteRange } from "../files.ts";
import type { WorkspacePort } from "../host.ts";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const fileRoutes = [
  {
    method: "GET",
    path: "/tree",
    operationId: "readTree",
    summary:
      "One directory level of the workspace, for a file browser. `path` is relative to the workspace root (empty or absent for the root itself; an absolute path reaches a linked context folder). Each entry is a `file` or a `dir`, directories first, then by name. Entries that a `.gitignore` between the root and this directory ignores are returned with `ignored: true` rather than dropped, so a browser can dim them. Dotfiles are left out unless `hidden=true`, and come flagged `hidden: true` when included. Every path is confined to the scope the agent's tools get: `..`, symlinks that leave it and anything outside the workspace answer 403.",
    authenticated: true,
    responses: {
      "200": "The directory's entries.",
      "403": "The path escapes the workspace scope.",
      "404": "No directory at that path.",
      "503": "This host serves no workspace.",
    },
  },
  {
    method: "GET",
    path: "/files",
    operationId: "readFile",
    summary:
      "A slice of one text file as UTF-8: the bytes `[from, to)` of it, the whole file when neither is given. At most 1 MiB comes back per request; when the slice was cut short, `truncated` is true and `to` says where it stopped, so the next request starts there. `bytes` is the whole file's size. A clipped tool result's `spill.elidedFrom` and `elidedTo` are the `from` and `to` that open the clipped range. Files over 20 MiB are refused, a slice holding a NUL byte is refused as binary, and `path` is confined exactly as for `/tree`.",
    authenticated: true,
    responses: {
      "200": "The slice.",
      "400": "`from` or `to` is not a non-negative integer.",
      "403": "The path escapes the workspace scope.",
      "404": "No file at that path.",
      "413": "The file is over the 20 MiB cap.",
      "415": "The slice holds a NUL byte: a binary file.",
      "503": "This host serves no workspace.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const fileFamily = {
  routes: fileRoutes,
  handlers: ({ host }) => {
    const workspace = servedBy((): WorkspacePort | undefined => host.workspace, "the workspace");
    return {
      readTree: workspace(async (port, request) => {
        const query = new URL(request.url).searchParams;
        const hidden = query.get("hidden");
        return json(
          200,
          await port.tree(query.get("path") ?? "", hidden === "true" || hidden === "1"),
        );
      }),
      readFile: workspace(async (port, request) => {
        const query = new URL(request.url).searchParams;
        const range = byteRangeOf(query);
        if (range === undefined) {
          return json(400, { error: "from and to must be non-negative integers" });
        }
        return json(200, await port.file(query.get("path") ?? "", range));
      }),
    };
  },
} satisfies RouteFamily<typeof fileRoutes>;

export function byteRangeOf(query: URLSearchParams): ByteRange | undefined {
  const from = offsetOf(query.get("from"));
  const to = offsetOf(query.get("to"));
  if (from === null || to === null) return undefined;
  return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
}

function offsetOf(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  return /^\d+$/.test(value) ? Number(value) : null;
}
