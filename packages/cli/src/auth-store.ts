import { homedir } from "node:os";
import { join } from "node:path";
import { type JsonFileStore, jsonFileStore } from "@keywork/shared";

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
  return credentialStore(dir).read() ?? {};
}

export async function saveCredential(
  provider: string,
  credential: Credential,
  dir: string = defaultAuthDir(),
): Promise<string> {
  const store = credentialStore(dir);
  store.write({ ...store.read(), [provider]: credential });
  return store.file;
}

export async function deleteCredential(
  provider: string,
  dir: string = defaultAuthDir(),
): Promise<boolean> {
  const store = credentialStore(dir);
  const { [provider]: removed, ...rest } = store.read() ?? {};
  if (removed === undefined) return false;
  store.write(rest);
  return true;
}

export function legacyCredentials(apiKeys: Record<string, string> | undefined): CredentialMap {
  return Object.fromEntries(
    Object.entries(apiKeys ?? {})
      .filter(([, key]) => key !== "")
      .map(([provider, key]) => [provider, { type: "api_key", key } as const]),
  );
}

function credentialStore(dir: string): JsonFileStore<CredentialMap> {
  return jsonFileStore<CredentialMap>({
    file: join(dir, "auth.json"),
    mode: "lenient",
    private: true,
    validate: onlyCredentialEntries,
  });
}

function onlyCredentialEntries(data: unknown): CredentialMap {
  if (typeof data !== "object" || data === null) return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).flatMap(([provider, value]) => {
      const credential = asCredential(value);
      return credential === undefined ? [] : [[provider, credential] as const];
    }),
  );
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
