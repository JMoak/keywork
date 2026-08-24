import type { PermissionResolver } from "@keywork/engine";
import {
  type ActivePreset,
  activePreset,
  type PermissionsConfig,
  type PresetName,
  permissionPolicy,
  permissionPresets,
  presetOrder,
  requiresConfirmation,
} from "@keywork/shared";
import type { PresetsPort } from "@keywork/tui";
import { updateUserConfig } from "./user-config.ts";

export interface PresetPort {
  active(): ActivePreset;
  apply(name: PresetName): Promise<void>;
}

export interface PresetSwitch extends PresetPort {
  resolver: PermissionResolver;
}

export interface PresetSwitchOptions {
  initial: PermissionsConfig | undefined;
  persist(permissions: PermissionsConfig): Promise<void>;
}

export function createPresetSwitch(options: PresetSwitchOptions): PresetSwitch {
  let permissions = options.initial;
  let resolver = permissionsResolver(permissions);
  return {
    resolver: (call) => resolver(call),
    active: () => activePreset(permissions),
    apply: async (name) => {
      await options.persist(permissionPresets[name]);
      permissions = permissionPresets[name];
      resolver = permissionsResolver(permissions);
    },
  };
}

export function userPresetSwitch(initial: PermissionsConfig | undefined): PresetSwitch {
  return createPresetSwitch({
    initial,
    persist: async (permissions) => {
      await updateUserConfig((existing) => ({ ...existing, permissions }));
    },
  });
}

export function permissionsResolver(
  permissions: PermissionsConfig | undefined,
): PermissionResolver {
  const policy = permissionPolicy(permissions);
  return (call) => policy(call.name, call.arguments);
}

export function presetResolver(name: PresetName): PermissionResolver {
  return permissionsResolver(permissionPresets[name]);
}

export function presetsPortFor(presets: PresetPort): PresetsPort {
  return {
    names: () => presetOrder,
    active: () => presets.active(),
    requiresConfirmation: (name) =>
      isPresetName(name) && requiresConfirmation(presets.active(), name),
    apply: async (name) => {
      if (isPresetName(name)) await presets.apply(name);
    },
  };
}

export async function presetCommand(
  args: string,
  port: PresetPort | undefined,
  print: (line: string) => void,
  confirm: (question: string) => Promise<boolean>,
): Promise<void> {
  if (port === undefined) {
    print("presets unavailable in this session");
    return;
  }
  const active = port.active();
  if (args === "") {
    print(presetListing(active));
    return;
  }
  if (!isPresetName(args)) {
    print(`no preset named "${args}". options: ${presetOrder.join(" · ")}`);
    return;
  }
  if (active === args) {
    print(`already on ${args}`);
    return;
  }
  if (requiresConfirmation(active, args)) {
    const agreed = await confirm(
      `switching ${active} → ${args} loosens permissions. continue? y/n `,
    );
    if (!agreed) {
      print("left unchanged");
      return;
    }
  }
  await port.apply(args);
  print(`permissions preset → ${args}`);
}

export function presetListing(active: ActivePreset): string {
  const words = presetOrder.map((name) => (name === active ? `${name}*` : name));
  return active === "custom"
    ? `${words.join(" · ")} · custom* (edited permissions config)`
    : words.join(" · ");
}

export function isPresetName(name: string): name is PresetName {
  return (presetOrder as readonly string[]).includes(name);
}
