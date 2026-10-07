export { SecretStoreError } from "./backend.ts";
export {
  CommandMissingError,
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "./command.ts";
export {
  hasSecretRefs,
  revealSecretRefs,
  revealServerSecrets,
  SecretNotFoundError,
  secretRefName,
  secretRefPrefix,
} from "./refs.ts";
export {
  type PlatformVaultOptions,
  platformVault,
  type SecretVault,
  secretNamePattern,
} from "./vault.ts";
