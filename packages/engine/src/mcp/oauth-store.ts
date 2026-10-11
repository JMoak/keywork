import { createHash } from "node:crypto";
import type { SecretVault } from "@keywork/shared";
import type { ClientCredentials } from "./oauth-wire.ts";
import { asRecord } from "./wire.ts";

export interface StoredToken {
  issuer: string;
  resource: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  client: ClientCredentials;
}

export interface StoredClient extends ClientCredentials {
  issuer: string;
}

export function tokenSecretName(issuer: string, resource: string): string {
  return `mcp-token.${label(resource)}.${digest(issuer, resource)}`;
}

export function clientSecretName(issuer: string): string {
  return `mcp-client.${label(issuer)}.${digest(issuer)}`;
}

export class OAuthStore {
  constructor(private readonly vault: SecretVault | undefined) {}

  get available(): boolean {
    return this.vault !== undefined;
  }

  async token(issuer: string, resource: string): Promise<StoredToken | undefined> {
    const record = await this.read(tokenSecretName(issuer, resource));
    return record === undefined ? undefined : storedTokenOf(record);
  }

  saveToken(token: StoredToken): Promise<void> {
    return this.write(tokenSecretName(token.issuer, token.resource), token);
  }

  async forgetToken(issuer: string, resource: string): Promise<void> {
    await this.vault?.forget(tokenSecretName(issuer, resource));
  }

  async client(issuer: string): Promise<StoredClient | undefined> {
    const record = await this.read(clientSecretName(issuer));
    return record === undefined ? undefined : storedClientOf(record);
  }

  saveClient(client: StoredClient): Promise<void> {
    return this.write(clientSecretName(client.issuer), client);
  }

  private async read(name: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.vault?.lookup(name);
    if (raw === undefined) return undefined;
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private async write(name: string, record: unknown): Promise<void> {
    if (this.vault === undefined) {
      throw new Error(
        "no OS credential store on this platform, so sign-in has nowhere to keep tokens",
      );
    }
    await this.vault.store(name, JSON.stringify(record));
  }
}

function storedTokenOf(record: Record<string, unknown>): StoredToken | undefined {
  const client = clientOf(asRecord(record.client));
  if (
    typeof record.issuer !== "string" ||
    typeof record.resource !== "string" ||
    typeof record.tokenEndpoint !== "string" ||
    typeof record.accessToken !== "string" ||
    client === undefined
  ) {
    return undefined;
  }
  return {
    issuer: record.issuer,
    resource: record.resource,
    tokenEndpoint: record.tokenEndpoint,
    accessToken: record.accessToken,
    ...(typeof record.refreshToken === "string" && { refreshToken: record.refreshToken }),
    ...(typeof record.expiresAt === "number" && { expiresAt: record.expiresAt }),
    ...(typeof record.scope === "string" && { scope: record.scope }),
    client,
  };
}

function storedClientOf(record: Record<string, unknown>): StoredClient | undefined {
  const client = clientOf(record);
  if (client === undefined || typeof record.issuer !== "string") return undefined;
  return { ...client, issuer: record.issuer };
}

function clientOf(record: Record<string, unknown>): ClientCredentials | undefined {
  if (typeof record.clientId !== "string") return undefined;
  return {
    clientId: record.clientId,
    ...(typeof record.clientSecret === "string" && { clientSecret: record.clientSecret }),
  };
}

function label(url: string): string {
  const host = new URL(url).host.toLowerCase().replaceAll(/[^a-z0-9.-]/g, "-");
  return host.slice(0, 48);
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
