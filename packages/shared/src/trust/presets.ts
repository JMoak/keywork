import type { PermissionEffect, PermissionRule, PermissionsConfig } from "../config/schema.ts";
import { permissionRules } from "./rules.ts";

export const presetOrder = ["careful", "standard", "open"] as const;

export type PresetName = (typeof presetOrder)[number];
export type ActivePreset = PresetName | "custom";

export const defaultPreset: PresetName = "standard";

export const permissionPresets: Readonly<Record<PresetName, PermissionRule[]>> = {
  careful: everyCoreTool("ask"),
  standard: [],
  open: everyCoreTool("allow"),
};

export function activePreset(config: PermissionsConfig | undefined): ActivePreset {
  const configured = ruleSet(permissionRules(config));
  return (
    presetOrder.find((name) => sameRules(configured, ruleSet(permissionPresets[name]))) ?? "custom"
  );
}

export function requiresConfirmation(from: ActivePreset, to: PresetName): boolean {
  if (from === to) return false;
  if (from === "custom") return true;
  return presetOrder.indexOf(to) > presetOrder.indexOf(from);
}

function everyCoreTool(effect: PermissionEffect): PermissionRule[] {
  return ["read", "write", "edit", "bash"].map((action) => ({ action, resource: "*", effect }));
}

function ruleSet(rules: readonly PermissionRule[]): string[] {
  return rules.map(({ action, resource, effect }) => `${action}\0${resource}\0${effect}`).sort();
}

function sameRules(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}
