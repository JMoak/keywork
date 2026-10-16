import type { PermissionsView } from "@keywork/engine";
import {
  type GrantAheadRefusal,
  grantAheadRefusal,
  type PermissionRule,
  ruleLabel,
  sameRule,
} from "@keywork/shared";
import { surfaceChanged } from "./answers.ts";
import { askRefusals } from "./asks.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const grantedRule: JsonSchema = {
  type: "object",
  required: ["action", "resource", "effect"],
  properties: {
    action: { type: "string", minLength: 1 },
    resource: { type: "string", minLength: 1 },
    effect: { type: "string", const: "allow" },
  },
  additionalProperties: false,
};

const ruleBody: JsonSchema = {
  type: "object",
  required: ["rule"],
  properties: { rule: grantedRule },
  additionalProperties: false,
};

const malformedRuleResponse = 'The body is not `{ rule: { action, resource, effect: "allow" } }`.';

const refusedGrantResponse =
  "The workspace is not trusted, or the rule is neither one an answered ask would record nor a whole MCP server: a `write` or `edit` rule, a pattern over tool names, an `mcp` rule over part of a server or over several, a wildcard over a delete or `git branch -D`, any force push, hard reset, `git clean` or discarding checkout, or any other shape (`error` names what an answer would record instead, when there is one).";

const permissionsChanged =
  '`surface.changed` with `kind: "permissions"` fires whenever this answer would change.';

export const permissionRoutes = [
  {
    method: "GET",
    path: "/permissions",
    operationId: "listPermissions",
    summary: `What this server allows beyond the configured rules, so every grant is visible: \`{ trusted, bundle, workspace, session }\`. \`bundle\` is the fixed read-only posture a trusted workspace gets (empty when untrusted), \`workspace\` the grants recorded by \`scope: "workspace"\` answers and workspace grants, and \`session\` the grants from \`scope: "session"\` answers and session grants, keyed by session id. Configured rules decide first; where they are silent, session grants, then workspace grants, then the bundle decide. ${permissionsChanged}`,
    authenticated: true,
    responses: { "200": "`{ trusted, bundle, workspace, session }`." },
  },
  {
    method: "POST",
    path: "/permissions/workspace/grant",
    operationId: "grantWorkspaceRule",
    summary:
      'Record one rule for every session of this workspace before any call asks for it, exactly where a `scope: "workspace"` answer to an ask records it. Only a rule an answered ask could have recorded is taken, or a whole MCP server: a `bash` rule in the shape an ask derives (`npm run *`, `git push *`, a delete only as its exact command), an MCP tool with resource `*`, or every tool of one MCP server as one rule, action `mcp` with resource `<server>__*`. A trusted-workspace setup can accept its proposals this way, one rule at a time. Fires `surface.changed` with `kind: "permissions"`.',
    authenticated: true,
    requestBody: ruleBody,
    responses: {
      "200": "`{ granted: rule }`.",
      "400": malformedRuleResponse,
      "409": refusedGrantResponse,
    },
  },
  {
    method: "POST",
    path: "/permissions/session/{sessionId}/grant",
    operationId: "grantSessionRule",
    summary:
      'Record one rule for that session before any call asks for it, exactly where a `scope: "session"` answer records it; it ends with the server process like every session grant. The same rules are taken as for POST /permissions/workspace/grant. Fires `surface.changed` with `kind: "permissions"`.',
    authenticated: true,
    requestBody: ruleBody,
    responses: {
      "200": "`{ granted: rule }`.",
      "400": malformedRuleResponse,
      "404": "No session has that id.",
      "409": refusedGrantResponse,
    },
  },
  {
    method: "POST",
    path: "/permissions/workspace/revoke",
    operationId: "revokeWorkspaceGrant",
    summary:
      'Remove one workspace grant, so the call it covered asks again in every session of this workspace. Fires `surface.changed` with `kind: "permissions"`.',
    authenticated: true,
    requestBody: ruleBody,
    responses: {
      "200": "`{ revoked: rule }`.",
      "400": malformedRuleResponse,
      "404": "No workspace grant matches that rule.",
    },
  },
  {
    method: "POST",
    path: "/permissions/session/{sessionId}/revoke",
    operationId: "revokeSessionGrant",
    summary:
      'Remove one grant a `scope: "session"` answer recorded for that session, so the call it covered asks again there. Other sessions and the workspace grants are untouched. Fires `surface.changed` with `kind: "permissions"`.',
    authenticated: true,
    requestBody: ruleBody,
    responses: {
      "200": "`{ revoked: rule }`.",
      "400": malformedRuleResponse,
      "404": "That session holds no grant matching the rule.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const permissionFamily = {
  routes: permissionRoutes,
  handlers: ({ host, log }) => {
    const workspaceGrants: GrantScope = {
      held: (view) => view.workspace,
      record: async (rule) => {
        await host.grantWorkspaceRule(rule);
        return true;
      },
      revoke: (rule) => host.revokeWorkspaceGrant(rule),
      unmatched: "no workspace grant matches that rule",
    };
    const sessionGrants = (sessionId: string): GrantScope => ({
      held: (view) => view.session[sessionId] ?? [],
      record: (rule) => host.grantSessionRule(sessionId, rule),
      revoke: (rule) => host.revokeSessionGrant(sessionId, rule),
      unmatched: "that session holds no grant matching that rule",
    });
    const grantAhead = async (request: Request, scope: GrantScope): Promise<Response> => {
      const rule = await requestedRuleOf(request);
      if (rule === undefined) return malformedRule();
      const view = await host.permissions();
      if (!view.trusted) return json(409, { error: untrustedRefusal });
      const refusal = grantAheadRefusal(rule);
      if (refusal !== undefined) return json(409, { error: refusalWords(rule, refusal) });
      const fresh = !scope.held(view).some((held) => sameRule(held, rule));
      if (!(await scope.record(rule))) return missingSession();
      if (fresh) surfaceChanged(log, "permissions");
      return json(200, { granted: rule });
    };
    const revoking = async (request: Request, scope: GrantScope): Promise<Response> => {
      const rule = await requestedRuleOf(request);
      if (rule === undefined) return malformedRule();
      if (!(await scope.revoke(rule))) return json(404, { error: scope.unmatched });
      surfaceChanged(log, "permissions");
      return json(200, { revoked: rule });
    };
    return {
      listPermissions: async () => json(200, await host.permissions()),
      grantWorkspaceRule: (request) => grantAhead(request, workspaceGrants),
      grantSessionRule: (request, { sessionId }) =>
        grantAhead(request, sessionGrants(sessionId ?? "")),
      revokeWorkspaceGrant: (request) => revoking(request, workspaceGrants),
      revokeSessionGrant: (request, { sessionId }) =>
        revoking(request, sessionGrants(sessionId ?? "")),
    };
  },
} satisfies RouteFamily<typeof permissionRoutes>;

interface GrantScope {
  held(view: PermissionsView): readonly PermissionRule[];
  record(rule: PermissionRule): Promise<boolean>;
  revoke(rule: PermissionRule): Promise<boolean>;
  unmatched: string;
}

const untrustedRefusal =
  "this workspace is not trusted, so no grant is recorded ahead of an ask; trust it first";

function refusalWords(rule: PermissionRule, refusal: GrantAheadRefusal): string {
  switch (refusal.kind) {
    case "write-once":
      return askRefusals["write-once"];
    case "tool-pattern":
      return "a grant names one tool, or one whole MCP server as mcp <server>__*, never a pattern over tool names";
    case "server-pattern":
      return "an mcp grant covers one whole server as <server>__*, never part of a server or several";
    case "destructive":
      return refusal.remembered === "exact-command"
        ? `${refusal.command} is remembered only as the exact command, never under a wildcard`
        : `${refusal.command} is approved once at a time; no grant remembers it`;
    case "underivable":
      return underivableWords(rule, refusal.derived);
  }
}

function underivableWords(rule: PermissionRule, derived: readonly PermissionRule[]): string {
  const asked = `an answered ask never records ${ruleLabel(rule)}`;
  if (derived.length === 0) {
    return `${asked}; grants hold bash commands and MCP tools as an answer would remember them, or a whole MCP server as mcp <server>__*`;
  }
  return `${asked}; it would record ${derived.map(ruleLabel).join(" and ")}`;
}

async function requestedRuleOf(request: Request): Promise<PermissionRule | undefined> {
  return grantedRuleOf(fieldsOf<{ rule: unknown }>(await bodyOf(request))?.rule);
}

function malformedRule(): Response {
  return json(400, { error: 'the body must be { rule: { action, resource, effect: "allow" } }' });
}

function grantedRuleOf(value: unknown): PermissionRule | undefined {
  const fields = fieldsOf<PermissionRule>(value);
  const action = nonBlank(fields?.action);
  const resource = nonBlank(fields?.resource);
  if (action === undefined || resource === undefined || fields?.effect !== "allow") {
    return undefined;
  }
  return { action, resource, effect: "allow" };
}
