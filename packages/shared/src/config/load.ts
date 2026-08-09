import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { configSchema, defaultConfig, type KeyworkConfig } from "./schema.ts";

export interface ConfigSource {
  userDir?: string;
  projectDir?: string;
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

export async function loadConfig(source: ConfigSource): Promise<KeyworkConfig> {
  const layers = await Promise.all([readLayer(source.userDir), readLayer(source.projectDir)]);
  return layers
    .filter((layer): layer is KeyworkConfig => layer !== undefined)
    .reduce(mergeConfigs, defaultConfig);
}

export function mergeConfigs(base: KeyworkConfig, overlay: KeyworkConfig): KeyworkConfig {
  return {
    ...base,
    ...overlay,
    keybindings: { ...base.keybindings, ...overlay.keybindings },
  };
}

async function readLayer(dir: string | undefined): Promise<KeyworkConfig | undefined> {
  if (dir === undefined) return undefined;
  const file = join(dir, "keywork.json");
  const raw = await readFileIfExists(file);
  if (raw === undefined) return undefined;
  return parseLayer(file, raw);
}

function parseLayer(file: string, raw: string): KeyworkConfig {
  const json = parseJson(file, raw);
  const result = configSchema.safeParse(json);
  if (!result.success) throw new ConfigError(file, z.prettifyError(result.error));
  return result.data;
}

function parseJson(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON: ${(cause as Error).message}`);
  }
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
