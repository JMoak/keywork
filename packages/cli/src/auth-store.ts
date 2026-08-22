import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./user-config.ts";

export type Credential = { type: "api_key"; key: string } | OauthCredential;

export interface OauthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export type CredentialMap = Record<string, Credential>;

export function defaultAuthDir(): string {
  return join(homedir(), ".keywork");
}

export async function readCredentials(dir: string = defaultAuthDir()): Promise<CredentialMap> {
  const raw = await readFile(join(dir, "auth.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([provider, value]) => {
      const credential = asCredential(value);
      return credential === undefined ? [] : [[provider, credential] as const];
    }),
  );
}

export async function saveCredential(
  provider: string,
  credential: Credential,
  dir: string = defaultAuthDir(),
): Promise<string> {
  const existing = await readCredentials(dir);
  return writeCredentials({ ...existing, [provider]: credential }, dir);
}

export async function deleteCredential(
  provider: string,
  dir: string = defaultAuthDir(),
): Promise<boolean> {
  const { [provider]: removed, ...rest } = await readCredentials(dir);
  if (removed === undefined) return false;
  await writeCredentials(rest, dir);
  return true;
}

export function legacyCredentials(apiKeys: Record<string, string> | undefined): CredentialMap {
  return Object.fromEntries(
    Object.entries(apiKeys ?? {})
      .filter(([, key]) => key !== "")
      .map(([provider, key]) => [provider, { type: "api_key", key } as const]),
  );
}

async function writeCredentials(credentials: CredentialMap, dir: string): Promise<string> {
  const file = join(dir, "auth.json");
  await writePrivateFile(file, `${JSON.stringify(credentials, null, 2)}\n`);
  return file;
}

function asCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  if (fields.type === "api_key" && typeof fields.key === "string") {
    return { type: "api_key", key: fields.key };
  }
  if (
    fields.type === "oauth" &&
    typeof fields.access === "string" &&
    typeof fields.refresh === "string" &&
    typeof fields.expires === "number"
  ) {
    return {
      type: "oauth",
      access: fields.access,
      refresh: fields.refresh,
      expires: fields.expires,
      ...(typeof fields.accountId === "string" && { accountId: fields.accountId }),
    };
  }
  return undefined;
}
