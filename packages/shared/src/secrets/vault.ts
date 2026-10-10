import { join } from "node:path";
import { type CommandRunner, runCommand } from "./command.ts";
import { dpapiVault } from "./dpapi.ts";
import { keychainVault } from "./keychain.ts";
import { secretServiceVault } from "./secret-service.ts";

export interface SecretVault {
  readonly backend: string;
  store(name: string, value: string): Promise<void>;
  lookup(name: string): Promise<string | undefined>;
  forget(name: string): Promise<void>;
}

export interface PlatformVaultOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export const secretNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function platformVault(options: PlatformVaultOptions): SecretVault | undefined {
  const run = options.run ?? runCommand;
  const backend = backendFor(options.platform ?? process.platform, options.dataDir, run);
  return backend === undefined ? undefined : checkingNames(backend);
}

function backendFor(
  platform: NodeJS.Platform,
  dataDir: string,
  run: CommandRunner,
): SecretVault | undefined {
  switch (platform) {
    case "win32":
      return dpapiVault(join(dataDir, "secrets"), run);
    case "darwin":
      return keychainVault(run);
    case "linux":
    case "freebsd":
    case "openbsd":
      return secretServiceVault(run);
    default:
      return undefined;
  }
}

function checkingNames(vault: SecretVault): SecretVault {
  return {
    backend: vault.backend,
    store: async (name, value) => vault.store(validName(name), value),
    lookup: async (name) => vault.lookup(validName(name)),
    forget: async (name) => vault.forget(validName(name)),
  };
}

function validName(name: string): string {
  if (secretNamePattern.test(name)) return name;
  throw new Error(`secret names are letters, digits, . _ - (got ${JSON.stringify(name)})`);
}
