import type { WorkspacePort } from "../host.ts";
import { servedBy, surfaceChanged } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const workspaceRoutes = [
  {
    method: "GET",
    path: "/workspace",
    operationId: "readWorkspace",
    summary:
      "The workspace this server was launched for. `anchor` is its root and where the root came from: `declaration` when a `.keywork/workspace.json` was found walking up from the launch directory, `git` when a repository root was, `launch` when neither and the launch directory itself is the root. `identity` is the key its sessions and tickets are filed under (the same value as this document's `info.workspace.identity`). When a declaration exists, `declared` is true and `name`, `declarationFile`, `contextDirs` (extra folders the agent's tools and memory may reach), `missingContextDirs`, `focusDirs` (subtrees the workspace is about) and the memory `vault` describe it. `trust` is the user's standing decision for this root and `readiness` folds the two together: `ready` (trusted and declared), `undeclared` (trusted, no declaration yet), `undecided` (no decision yet, so nothing runs with project access) or `refused` (marked untrusted).",
    authenticated: true,
    responses: {
      "200": "The workspace report.",
      "503": "This host serves no workspace.",
    },
  },
  {
    method: "POST",
    path: "/workspace/trust",
    operationId: "trustWorkspace",
    summary:
      'Trust the served workspace and set it up, exactly what `/init` in the terminal and `keywork trust` do: the decision is written for this root and no other (the body is ignored, so no path can be smuggled in) to the user\'s trust store, and `.keywork/workspace.json` plus the memory vault are created when missing. Trust is read when a server composes, so `keywork serve` composes itself again before it answers: the project\'s config, permissions, MCP servers, arcs and bots load, open sessions close (a running turn is interrupted and keeps what it had) and reopen on their next request, pending asks are refused, and the URL, the token, the ticket and the event stream stay as they were. `recomposed: true` says that happened, and `GET /permissions` reflects trust as soon as the answer arrives; `surface.changed` fires with `kind: "workspaces"` and, after a recompose, `kind: "permissions"`. `reopens: true` says this host cannot recompose itself (an embedded host) and must be restarted before the decision takes effect; a client that owns the process restarts it. Already trusted is not an error and answers both false. This route never untrusts and never forgets a decision.',
    authenticated: true,
    responses: {
      "200":
        "`{ trusted: true, root, vault, reopens, recomposed }`; `root` names the directory the decision covers.",
      "400":
        "The root is a home directory or a filesystem root, which would trust everything beneath it.",
      "409": "The root is marked untrusted; only `keywork trust` in a terminal reverses that.",
      "503": "This host serves no workspace.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const workspaceFamily = {
  routes: workspaceRoutes,
  handlers: ({ host, log }) => {
    const workspace = servedBy((): WorkspacePort | undefined => host.workspace, "the workspace");
    return {
      readWorkspace: workspace(async (port) => json(200, await port.report())),
      trustWorkspace: workspace(async (port) => {
        const grant = await port.trust();
        surfaceChanged(log, "workspaces");
        if (grant.recomposed) surfaceChanged(log, "permissions");
        return json(200, grant);
      }),
    };
  },
} satisfies RouteFamily<typeof workspaceRoutes>;
