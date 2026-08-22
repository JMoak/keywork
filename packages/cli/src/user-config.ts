import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, configSchema, type KeyworkConfig } from "@keywork/shared";

export function userConfigDir(): string {
  return join(homedir(), ".keywork");
}

export async function updateUserConfig(
  mutate: (existing: KeyworkConfig) => KeyworkConfig,
  dir: string = userConfigDir(),
): Promise<string> {
  const file = join(dir, "keywork.json");
  const merged = mutate(await readConfigFile(file));
  await writePrivateFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

export async function readUserConfig(dir: string = userConfigDir()): Promise<KeyworkConfig> {
  return readConfigFile(join(dir, "keywork.json"));
}

export type PrivateFileDisk = Pick<
  typeof import("node:fs/promises"),
  "mkdir" | "writeFile" | "chmod" | "rename" | "rm"
>;

const realDisk: PrivateFileDisk = { mkdir, writeFile, chmod, rename, rm };

export async function writePrivateFile(
  file: string,
  contents: string,
  disk: PrivateFileDisk = realDisk,
): Promise<void> {
  await disk.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await disk.writeFile(staging, contents, { encoding: "utf8", mode: 0o600 });
    await disk.chmod(staging, 0o600);
    await disk.rename(staging, file);
  } catch (cause) {
    await disk.rm(staging, { force: true });
    throw cause;
  }
}

async function readConfigFile(file: string): Promise<KeyworkConfig> {
  const raw = await readFileIfExists(file);
  if (raw === undefined) return {};
  const parsed = configSchema.safeParse(parseJson(file, raw));
  if (!parsed.success) throw new ConfigError(file, describeIssues(parsed.error.issues));
  return parsed.data;
}

const absenceCodes = new Set(["ENOENT", "ENOTDIR"]);

async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    if (absenceCodes.has(code)) return undefined;
    throw new ConfigError(file, `unreadable (${code}): ${(cause as Error).message}`);
  }
}

function parseJson(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(file, `not valid JSON: ${(cause as Error).message}`);
  }
}

function describeIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "config"}: ${issue.message}`)
    .join("\n");
}
