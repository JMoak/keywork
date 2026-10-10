import type { ExtensionFactory } from "@keywork/engine";

export type {
  CustomEntryDelivery,
  ExtensionApi,
  ExtensionCommand,
  ExtensionFactory,
  ExtensionFlag,
  ExtensionLogger,
  ExtensionShortcut,
  ExtensionTeardown,
  HookHandler,
  HookHandlers,
  HookName,
  HookPayload,
  HookResult,
  Hooks,
  ToolCallDecision,
  ToolResultReport,
} from "@keywork/engine";
export { typedOnlyHooks, wiredHooks } from "@keywork/engine";

export const extensionsVersion = "0.0.1";

export function defineExtension(activate: ExtensionFactory): ExtensionFactory {
  return activate;
}
