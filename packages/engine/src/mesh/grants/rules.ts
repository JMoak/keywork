import { type PermissionRule, withRules } from "@keywork/shared";
import type { Cap } from "./caps.ts";
import type { Grant } from "./grant.ts";

export function grantRules(grant: Pick<Grant, "caps">): PermissionRule[] {
  return grant.caps.flatMap(capRules);
}

export function subjectRules(grants: readonly Pick<Grant, "caps">[]): PermissionRule[] {
  return withRules([], grants.flatMap(grantRules));
}

function capRules(cap: Cap): PermissionRule[] {
  switch (cap.kind) {
    case "files:read":
      return cap.paths.map((path) => allow("read", path));
    case "files:write":
      return cap.paths.flatMap((path) => [allow("write", path), allow("edit", path)]);
    case "exec":
      return cap.commands.map((command) => allow("bash", `${command} *`));
    default:
      return [];
  }
}

function allow(action: string, resource: string): PermissionRule {
  return { action, resource, effect: "allow" };
}
