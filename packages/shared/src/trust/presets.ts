import type { PermissionAction, PermissionsConfig } from "../config/schema.ts";

export const presetOrder = ["careful", "standard", "open"] as const;

export type PresetName = (typeof presetOrder)[number];
export type ActivePreset = PresetName | "custom";

export const defaultPreset: PresetName = "standard";

export const permissionPresets: Readonly<Record<PresetName, PermissionsConfig>> = {
  careful: { tools: { read: "ask", write: "ask", edit: "ask", bash: "ask" } },
  standard: {},
  open: { tools: { read: "allow", write: "allow", edit: "allow", bash: "allow" } },
};

export function activePreset(config: PermissionsConfig | undefined): ActivePreset {
  return presetOrder.find((name) => sameMatrix(config, permissionPresets[name])) ?? "custom";
}

export function requiresConfirmation(from: ActivePreset, to: PresetName): boolean {
  if (from === to) return false;
  if (from === "custom") return true;
  return presetOrder.indexOf(to) > presetOrder.indexOf(from);
}

function sameMatrix(left: PermissionsConfig | undefined, right: PermissionsConfig): boolean {
  return sameRules(left?.tools, right.tools) && sameRules(left?.bash, right.bash);
}

type Rules = Record<string, PermissionAction> | undefined;

function sameRules(left: Rules, right: Rules): boolean {
  const actual = Object.entries(left ?? {});
  const expected = new Map(Object.entries(right ?? {}));
  return (
    actual.length === expected.size &&
    actual.every(([pattern, action]) => expected.get(pattern) === action)
  );
}
