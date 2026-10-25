import type { CustomEntry, SessionEntry, SessionStore } from "@keywork/engine";
import type { PermissionRule } from "@keywork/shared";

export const sessionGrantsType = "session_grants";

export function heldGrantsOf(store: SessionStore): readonly PermissionRule[] | undefined {
  const latest = store.entries().findLast(isGrantsSnapshot);
  return latest === undefined ? undefined : allowRulesIn(latest.data);
}

export async function recordHeldGrants(
  store: SessionStore,
  rules: readonly PermissionRule[],
): Promise<void> {
  await store.appendCustom(sessionGrantsType, { rules });
}

function isGrantsSnapshot(entry: SessionEntry): entry is CustomEntry {
  return entry.type === "custom" && entry.customType === sessionGrantsType;
}

function allowRulesIn(data: unknown): PermissionRule[] {
  const rules = (data as { rules?: unknown } | undefined)?.rules;
  return Array.isArray(rules) ? rules.filter(isAllowRule) : [];
}

function isAllowRule(candidate: unknown): candidate is PermissionRule {
  const { action, resource, effect } = (candidate ?? {}) as Record<string, unknown>;
  return typeof action === "string" && typeof resource === "string" && effect === "allow";
}
