export { ConfigError, type ConfigSource, loadConfig, mergeConfigs } from "./load.ts";
export {
  configSchema,
  defaultConfig,
  type KeyworkConfig,
  type McpServerConfig,
  type PermissionAction,
  type PermissionsConfig,
  type PromptOverride,
  type PromptsConfig,
} from "./schema.ts";
export {
  openWorkspace,
  resolveVaultPath,
  type Workspace,
  type WorkspaceDeclaration,
  workspaceDeclarationSchema,
} from "./workspace.ts";
