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
  const [user, project] = await Promise.all([
    readLayer(source.userDir),
    readLayer(source.projectDir),
  ]);
  return applyLayers(defaultConfig, user, project && workspacePreferences(project));
}

export function mergeConfigs(base: KeyworkConfig, overlay: KeyworkConfig): KeyworkConfig {
  return {
    ...base,
    ...overlay,
    ...mergedRecord("keybindings", base, overlay),
    ...mergedRecord("theme", base, overlay),
    ...mergedRecord("apiKeys", base, overlay),
  };
}

// Trust boundary: a checked-in project file may adjust workspace preferences,
// never credentials or model routing — those stay user/env-owned.
function workspacePreferences(layer: KeyworkConfig): KeyworkConfig {
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

type RecordField = "keybindings" | "theme" | "apiKeys";

function mergedRecord<F extends RecordField>(
  field: F,
  base: KeyworkConfig,
  overlay: KeyworkConfig,
): Partial<Pick<KeyworkConfig, F>> {
  if (base[field] === undefined && overlay[field] === undefined) return {};
  return { [field]: { ...base[field], ...overlay[field] } } as Partial<Pick<KeyworkConfig, F>>;
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

const absenceCodes = new Set(["ENOENT", "ENOTDIR"]);

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    if (absenceCodes.has(code)) return undefined;
    throw new ConfigError(path, `unreadable (${code}): ${(cause as Error).message}`);
  }
}
