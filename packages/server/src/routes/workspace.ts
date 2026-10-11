import { maxFileSliceBytes } from "../host.ts";
import {
  bodyOf,
  byteRangeOf,
  type JsonSchema,
  json,
  queryOf,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const emptyBody: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

export const workspaceRoutes = [
  {
    method: "GET",
    path: "/workspace",
    operationId: "readWorkspace",
    summary:
      "The workspace this server was launched for: its anchor (the primary root and how it was found: a `.keywork/workspace.json` declaration, a git root, or the launch directory), the identity that keys its state, the declaration when one exists (name, linked context dirs, focus dirs, vault), the trust decision on record and the readiness that follows from it (`ready`, `undeclared`, `undecided`, `refused`).",
    authenticated: true,
    responses: { "200": "The workspace." },
  },
  {
    method: "GET",
    path: "/tree",
    operationId: "listTree",
    summary:
      "One directory level under `path` (relative to the anchor root; empty for the root itself). Entries are sorted directories first, then by name. Entries a `.gitignore` covers are returned with `ignored: true` rather than dropped, and dotfiles carry `hidden: true`, so a client applies its own view. The path is confined to the tool jail: the anchor root plus, once the workspace is trusted, its linked context dirs. Reading needs no trust.",
    authenticated: true,
    responses: {
      "200": "The listing.",
      "403": "The path escapes the workspace scope.",
      "404": "No directory at that path.",
    },
  },
  {
    method: "GET",
    path: "/files",
    operationId: "readFile",
    summary: `A byte range of a file as UTF-8 text: \`[from, to)\`, default the whole file, at most ${maxFileSliceBytes} bytes per request (\`truncated: true\` when the range was cut to fit; \`eof: true\` when \`to\` reached the end). \`from\` and \`to\` are the numbers a tool result's \`SpillReference.elidedFrom/To\` carry, so a spill opens at its range. Files over 20 MiB are refused whole, and a slice holding a NUL byte is refused as binary. Confined like /tree; reading needs no trust.`,
    authenticated: true,
    responses: {
      "200": "The slice.",
      "400": "`path` is missing, or `from`/`to` are not whole numbers.",
      "403": "The path escapes the workspace scope.",
      "404": "No file at that path.",
      "413": "The file is larger than 20 MiB.",
      "415": "The slice holds a NUL byte, so the file is treated as binary.",
    },
  },
  {
    method: "POST",
    path: "/workspace/trust",
    operationId: "trustWorkspace",
    summary:
      "Record trust for the served root, exactly as `keywork trust` and the terminal's `/init` do. The body is empty: the route takes no path, so it can trust nothing but the workspace this server was launched for, and it cannot untrust, forget, or grant session-only trust. Safety argument: the server binds loopback with a per-launch bearer whose ticket file is private to the user, so the caller is the same local user who could run `keywork trust` in this directory. Trust is read once when the workspace is composed, so the server does not recompose itself: it answers `reopens: true` and the client restarts `keywork serve`, the way the terminal reopens after `/init`. The client shows the same confirmation sentence the terminal shows before calling.",
    authenticated: true,
    requestBody: emptyBody,
    responses: {
      "200": "Trust is recorded; `reopens` says whether a restart is needed to act on it.",
      "400": "The body named a path, or the root is a home directory the store refuses to blanket.",
      "409": "The root is already marked untrusted; `keywork trust` in a terminal reverses that.",
    },
  },
  {
    method: "GET",
    path: "/themes",
    operationId: "listThemes",
    summary:
      "Every theme the server can hand a client whole: the curated gallery (keywork-night, keywork-day, and the Catppuccin, Nord, Gruvbox, Everforest, Kanagawa, Rosé Pine, Flexoki, matte-black, osaka-jade, and ristretto themes) plus any closet theme, which replaces a gallery theme of the same name. Each record is complete: name, appearance, tokens, density, gap, chromeWeight, instruments, and always terminal (the ANSI 16), syntax, diff, selection, and cursor, filled by keywork's derivation rule where the theme leaves one out, so every client paints from the same colors. `pair` names the opposite-appearance twin when there is one, so a client following the OS swaps between a matched light and dark. `active` is the configured startup theme. `placeholders` names themes the terminal derives from its own environment (`system`, from the terminal's colors); a client fills those from its own surface so both surfaces list the same names.",
    authenticated: true,
    responses: { "200": "The themes." },
  },
] as const satisfies readonly RouteSpec[];

export const workspaceFamily = {
  routes: workspaceRoutes,
  handlers: ({ host }) => ({
    readWorkspace: async () => json(200, await host.workspace()),
    listTree: async (request) => json(200, await host.tree(queryOf(request).get("path") ?? "")),
    readFile: async (request) => {
      const query = queryOf(request);
      const path = query.get("path");
      const range = byteRangeOf(query);
      if (path === null || path === "" || range === "invalid") {
        return json(400, { error: "the query must carry path, and whole-number from and to" });
      }
      return json(200, await host.readFile(path, range));
    },
    trustWorkspace: async (request) => {
      if (!isEmptyBody(await bodyOf(request))) {
        return json(400, {
          error: "the trust route takes no body; it trusts the served root only",
        });
      }
      return json(200, await host.trustWorkspace());
    },
    listThemes: async () => json(200, await host.themes()),
  }),
} satisfies RouteFamily<typeof workspaceRoutes>;

function isEmptyBody(body: unknown): boolean {
  if (body === undefined) return true;
  return typeof body === "object" && body !== null && Object.keys(body).length === 0;
}
