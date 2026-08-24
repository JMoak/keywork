import { join } from "node:path";
import { z } from "zod";
import { type JsonFileStore, jsonFileStore } from "../json-file-store.ts";
import { configSchema, defaultConfig, type KeyworkConfig } from "./schema.ts";

export interface ConfigSource {
  userDir?: string;
  projectDir?: string;
  projectTrusted?: boolean;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`Invalid config at ${file}:\n${detail}`);
    this.name = "ConfigError";
  }
}

export function keyworkConfigStore(file: string): JsonFileStore<KeyworkConfig> {
  return jsonFileStore<KeyworkConfig>({
    file,
    mode: "strict",
    private: true,
    error: (path, detail) => new ConfigError(path, detail),
    validate: (data) => {
      const result = configSchema.safeParse(data);
      if (!result.success) throw new ConfigError(file, z.prettifyError(result.error));
      return result.data;
    },
  });
}

export async function loadConfig(source: ConfigSource): Promise<KeyworkConfig> {
  const user = readLayer(source.userDir);
  const project = readLayer(source.projectTrusted === true ? source.projectDir : undefined);
  return applyLayers(defaultConfig, user, project && preferencesAllowedFromProjectLayer(project));
}

export function mergeConfigs(base: KeyworkConfig, overlay: KeyworkConfig): KeyworkConfig {
  return {
    ...base,
    ...overlay,
    ...mergedRecord("keybindings", base, overlay),
    ...mergedRecord("theme", base, overlay),
    ...mergedRecord("apiKeys", base, overlay),
    ...mergedRecord("mcpServers", base, overlay),
    ...mergedPrompts(base, overlay),
  };
}

function preferencesAllowedFromProjectLayer(layer: KeyworkConfig): KeyworkConfig {
  return {
    ...(layer.keybindings !== undefined && { keybindings: layer.keybindings }),
    ...(layer.theme !== undefined && { theme: layer.theme }),
  };
}

function applyLayers(
  base: KeyworkConfig,
  ...overlays: (KeyworkConfig | undefined)[]
): KeyworkConfig {
  return overlays
    .filter((overlay): overlay is KeyworkConfig => overlay !== undefined)
    .reduce(mergeConfigs, base);
}

type RecordField = "keybindings" | "theme" | "apiKeys" | "mcpServers";

function mergedRecord<F extends RecordField>(
  field: F,
  base: KeyworkConfig,
  overlay: KeyworkConfig,
): Partial<Pick<KeyworkConfig, F>> {
  if (base[field] === undefined && overlay[field] === undefined) return {};
  return { [field]: { ...base[field], ...overlay[field] } } as Partial<Pick<KeyworkConfig, F>>;
}

function mergedPrompts(
  base: KeyworkConfig,
  overlay: KeyworkConfig,
): Partial<Pick<KeyworkConfig, "prompts">> {
  if (base.prompts === undefined && overlay.prompts === undefined) return {};
  const models = { ...base.prompts?.models, ...overlay.prompts?.models };
  return {
    prompts: {
      ...base.prompts,
      ...overlay.prompts,
      ...(Object.keys(models).length > 0 && { models }),
    },
  };
}

function readLayer(dir: string | undefined): KeyworkConfig | undefined {
  if (dir === undefined) return undefined;
  return keyworkConfigStore(join(dir, "keywork.json")).read();
}
