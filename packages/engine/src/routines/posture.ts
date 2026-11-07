import type { PermissionRule } from "@keywork/shared";
import type { PermissionResolver, PermissionRuling } from "../agent.ts";
import type { CreatureSessionKind } from "../creatures/sessions.ts";
import { mutatingToolNames } from "../mutations.ts";
import type { GrantRule, ToolPosture } from "./routine.ts";

export const readOnlyRefusal: PermissionRuling = { permission: "deny", gate: "policy" };

export function postureResolver(
  posture: () => ToolPosture | undefined,
  base: PermissionResolver | undefined,
): PermissionResolver {
  return (call) =>
    posture() === "read-only" && mutatingToolNames.has(call.name) ? readOnlyRefusal : base?.(call);
}

export function sessionPosture(
  kind: CreatureSessionKind | undefined,
  confined: ToolPosture | undefined,
): ToolPosture | undefined {
  return confined ?? (kind === "routine" ? "read-only" : undefined);
}

export function acceptedGrantRules(grants: readonly GrantRule[]): PermissionRule[] {
  return grants.map(({ action, resource }) => ({ action, resource, effect: "allow" }));
}
