import type { McpServerConfig } from "../config/index.ts";
import type { SecretVault } from "./vault.ts";

export const secretRefPrefix = "secret:";

export class SecretNotFoundError extends Error {
  constructor(readonly secret: string) {
    super(`secret ${secret} is not in the OS credential store`);
    this.name = "SecretNotFoundError";
  }
}

export function secretRefName(value: string): string | undefined {
  return value.startsWith(secretRefPrefix) ? value.slice(secretRefPrefix.length) : undefined;
}

export function hasSecretRefs(values: Readonly<Record<string, string>> | undefined): boolean {
  return Object.values(values ?? {}).some((value) => secretRefName(value) !== undefined);
}

export async function revealSecretRefs(
  values: Readonly<Record<string, string>>,
  vault: SecretVault | undefined,
): Promise<Record<string, string>> {
  const revealed = await Promise.all(
    Object.entries(values).map(async ([key, value]) => [key, await reveal(value, vault)] as const),
  );
  return Object.fromEntries(revealed);
}

export async function revealServerSecrets(
  config: McpServerConfig,
  vault: SecretVault | undefined,
): Promise<McpServerConfig> {
  if (config.transport === "http") {
    if (config.headers === undefined) return config;
    return { ...config, headers: await revealSecretRefs(config.headers, vault) };
  }
  if (config.env === undefined) return config;
  return { ...config, env: await revealSecretRefs(config.env, vault) };
}

async function reveal(value: string, vault: SecretVault | undefined): Promise<string> {
  const name = secretRefName(value);
  if (name === undefined) return value;
  const secret = await vault?.lookup(name);
  if (secret === undefined) throw new SecretNotFoundError(name);
  return secret;
}
