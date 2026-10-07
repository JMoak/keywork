import { homedir } from "node:os";
import { join } from "node:path";
import {
  type JsonFileStore,
  jsonFileStore,
  type KeyworkConfig,
  platformVault,
  type SecretVault,
} from "@keywork/shared";

export type Credential = { type: "api_key"; key: string } | OauthCredential;

export interface OauthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export type CredentialMap = Record<string, Credential>;

export interface SecretKeeping {
  vault: SecretVault;
  notice(line: string): void;
}

export function defaultAuthDir(): string {
  return join(homedir(), ".keywork");
}

export function secretKeepingFor(
  config: Pick<KeyworkConfig, "secretStore">,
  notice: (line: string) => void,
  dir: string = defaultAuthDir(),
): SecretKeeping | undefined {
  if (config.secretStore === "plaintext") return undefined;
  return { vault: platformVault({ dataDir: dir }) ?? missingVault, notice };
}

export async function readCredentials(
  dir: string = defaultAuthDir(),
  keeping?: SecretKeeping,
): Promise<CredentialMap> {
  const stored = Object.entries(credentialStore(dir).read() ?? {});
  const revealed = await Promise.all(
    stored.map(([provider, entry]) => credentialFrom(provider, entry, keeping)),
  );
  return Object.fromEntries(
    stored.flatMap(([provider], index) => {
      const credential = revealed[index];
      return credential === undefined ? [] : [[provider, credential] as const];
    }),
  );
}

export async function saveCredential(
  provider: string,
  credential: Credential,
  dir: string = defaultAuthDir(),
  keeping?: SecretKeeping,
): Promise<string> {
  const entry = await storedEntryFor(provider, credential, keeping);
  const store = credentialStore(dir);
  store.write({ ...store.read(), [provider]: entry });
  return store.file;
}

export async function deleteCredential(
  provider: string,
  dir: string = defaultAuthDir(),
  keeping?: SecretKeeping,
): Promise<boolean> {
  const store = credentialStore(dir);
  const { [provider]: removed, ...rest } = store.read() ?? {};
  if (removed === undefined) return false;
  store.write(rest);
  if (removed.type === "vault") await keeping?.vault.forget(removed.secret);
  return true;
}

export function legacyCredentials(apiKeys: Record<string, string> | undefined): CredentialMap {
  return Object.fromEntries(
    Object.entries(apiKeys ?? {})
      .filter(([, key]) => key !== "")
      .map(([provider, key]) => [provider, { type: "api_key", key } as const]),
  );
}

interface VaultEntry {
  type: "vault";
  secret: string;
}

type StoredEntry = Credential | VaultEntry;

const missingVault: SecretVault = {
  backend: "no credential store",
  store: async () => {
    throw new Error(`no credential store is supported on ${process.platform}`);
  },
  lookup: async () => undefined,
  forget: async () => undefined,
};

async function storedEntryFor(
  provider: string,
  credential: Credential,
  keeping: SecretKeeping | undefined,
): Promise<StoredEntry> {
  if (keeping === undefined) return credential;
  const serialized = JSON.stringify(credential);
  const secret = secretNameFor(provider);
  try {
    await keeping.vault.store(secret, serialized);
    return { type: "vault", secret };
  } catch (cause) {
    keeping.notice(
      `keywork: couldn't use the OS credential store (${reasonOf(cause)}), so the ${provider} key went into auth.json as plaintext`,
    );
    return credential;
  }
}

function credentialFrom(
  provider: string,
  entry: StoredEntry,
  keeping: SecretKeeping | undefined,
): Promise<Credential | undefined> {
  return entry.type === "vault"
    ? revealFromVault(provider, entry, keeping)
    : Promise.resolve(entry);
}

async function revealFromVault(
  provider: string,
  entry: VaultEntry,
  keeping: SecretKeeping | undefined,
): Promise<Credential | undefined> {
  try {
    const sealed = await keeping?.vault.lookup(entry.secret);
    const credential = sealed === undefined ? undefined : asCredential(JSON.parse(sealed));
    if (credential === undefined) {
      keeping?.notice(`keywork: the saved ${provider} key is missing from the OS credential store`);
    }
    return credential;
  } catch (cause) {
    keeping?.notice(`keywork: couldn't read the saved ${provider} key (${reasonOf(cause)})`);
    return undefined;
  }
}

function secretNameFor(provider: string): string {
  return `provider.${provider}`;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function credentialStore(dir: string): JsonFileStore<Record<string, StoredEntry>> {
  return jsonFileStore<Record<string, StoredEntry>>({
    file: join(dir, "auth.json"),
    mode: "lenient",
    private: true,
    validate: onlyStoredEntries,
  });
}

function onlyStoredEntries(data: unknown): Record<string, StoredEntry> {
  if (typeof data !== "object" || data === null) return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).flatMap(([provider, value]) => {
      const entry = asStoredEntry(value);
      return entry === undefined ? [] : [[provider, entry] as const];
    }),
  );
}

function asStoredEntry(value: unknown): StoredEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  if (fields.type === "vault" && typeof fields.secret === "string") {
    return { type: "vault", secret: fields.secret };
  }
  return asCredential(value);
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
