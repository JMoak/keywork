import type { PermissionRule } from "@keywork/shared";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
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

const revokeBody: JsonSchema = {
  type: "object",
  required: ["rule"],
  properties: { rule: grantedRule },
  additionalProperties: false,
};

export const permissionRoutes = [
  {
    method: "GET",
    path: "/permissions",
    operationId: "listPermissions",
    summary:
      'What this server allows beyond the configured rules, so every grant is visible: `{ trusted, bundle, workspace, session }`. `bundle` is the fixed read-only posture a trusted workspace gets (empty when untrusted), `workspace` the grants recorded by `scope: "workspace"` answers, and `session` the grants from `scope: "session"` answers keyed by session id. Configured rules decide first; where they are silent, session grants, then workspace grants, then the bundle decide.',
    authenticated: true,
    responses: { "200": "`{ trusted, bundle, workspace, session }`." },
  },
  {
    method: "POST",
    path: "/permissions/workspace/revoke",
    operationId: "revokeWorkspaceGrant",
    summary:
      "Remove one workspace grant, so the call it covered asks again in every session of this workspace.",
    authenticated: true,
    requestBody: revokeBody,
    responses: {
      "200": "`{ revoked: rule }`.",
      "400": 'The body is not `{ rule: { action, resource, effect: "allow" } }`.',
      "404": "No workspace grant matches that rule.",
    },
  },
  {
    method: "POST",
    path: "/permissions/session/{sessionId}/revoke",
    operationId: "revokeSessionGrant",
    summary:
      'Remove one grant a `scope: "session"` answer recorded for that session, so the call it covered asks again there. Other sessions and the workspace grants are untouched.',
    authenticated: true,
    requestBody: revokeBody,
    responses: {
      "200": "`{ revoked: rule }`.",
      "400": 'The body is not `{ rule: { action, resource, effect: "allow" } }`.',
      "404": "That session holds no grant matching the rule.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const permissionFamily = {
  routes: permissionRoutes,
  handlers: ({ host }) => ({
    listPermissions: async () => json(200, await host.permissions()),
    revokeWorkspaceGrant: async (request) => {
      const rule = await revokedRuleOf(request);
      if (rule === undefined) return malformedRule();
      if (!(await host.revokeWorkspaceGrant(rule))) {
        return json(404, { error: "no workspace grant matches that rule" });
      }
      return json(200, { revoked: rule });
    },
    revokeSessionGrant: async (request, { sessionId }) => {
      const rule = await revokedRuleOf(request);
      if (rule === undefined) return malformedRule();
      if (!(await host.revokeSessionGrant(sessionId ?? "", rule))) {
        return json(404, { error: "that session holds no grant matching that rule" });
      }
      return json(200, { revoked: rule });
    },
  }),
} satisfies RouteFamily<typeof permissionRoutes>;

async function revokedRuleOf(request: Request): Promise<PermissionRule | undefined> {
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
