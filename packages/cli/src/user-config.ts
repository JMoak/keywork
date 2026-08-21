import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, type KeyworkConfig } from "@keywork/shared";

export function userConfigDir(): string {
  return join(homedir(), ".keywork");
}

export async function updateUserConfig(
  mutate: (existing: KeyworkConfig) => KeyworkConfig,
  dir: string = userConfigDir(),
): Promise<string> {
  const file = join(dir, "keywork.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const merged = mutate(await readKnownConfig(file));
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function readUserConfig(dir: string = userConfigDir()): Promise<KeyworkConfig> {
  return readKnownConfig(join(dir, "keywork.json"));
}

async function readKnownConfig(file: string): Promise<KeyworkConfig> {
  const raw = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (typeof raw !== "object" || raw === null) return {};
  const fields = raw as Record<string, unknown>;
  const known = Object.fromEntries(
    Object.keys(configSchema.shape)
      .filter((field) => field in fields)
      .map((field) => [field, fields[field]]),
  );
  const parsed = configSchema.safeParse(known);
  return parsed.success ? parsed.data : {};
}
