import type {
  LegacyPermissionsConfig,
  PermissionEffect,
  PermissionRule,
  PermissionsConfig,
} from "../config/schema.ts";
import { compileGlob } from "../glob.ts";

export function permissionRules(config: PermissionsConfig | undefined): readonly PermissionRule[] {
  if (config === undefined) return [];
  return Array.isArray(config) ? config : rulesFromLegacy(config);
}

export function rulesFromLegacy(legacy: LegacyPermissionsConfig): PermissionRule[] {
  return [...toolWideRules(legacy.tools ?? {}), ...bashRules(legacy.bash ?? {})];
}

type EffectMap = Readonly<Record<string, PermissionEffect>>;

function toolWideRules(tools: EffectMap): PermissionRule[] {
  return Object.entries(tools).map(([action, effect]) => ({ action, resource: "*", effect }));
}

function bashRules(patterns: EffectMap): PermissionRule[] {
  const declared = Object.entries(patterns).map(([resource, effect]) => ({
    action: "bash",
    resource,
    effect,
  }));
  const denies = declared.filter((rule) => rule.effect === "deny");
  const others = declared.filter((rule) => rule.effect !== "deny");
  return [...leastLiteralFirst(others), ...denies];
}

function leastLiteralFirst(rules: readonly PermissionRule[]): PermissionRule[] {
  return [...rules].reverse().sort((left, right) => literalness(left) - literalness(right));
}

function literalness(rule: PermissionRule): number {
  return compileGlob(rule.resource).specificity;
}
