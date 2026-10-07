import type { Message, ToolCallPart, Usage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import type { Tool } from "../tools.ts";

export type ExtensionSource = "user" | "project" | "inline";
export type SessionStartReason = "start" | "resume";
export type SessionEndReason = "exit" | "switch" | "reload";

export interface ExtensionApi {
  readonly name: string;
  readonly source: ExtensionSource;
  readonly log: ExtensionLogger;
  on<K extends HookName>(hook: K, handler: HookHandlers[K]): () => void;
  registerTool(tool: Tool): void;
  registerCommand(command: ExtensionCommand): void;
  registerShortcut(shortcut: ExtensionShortcut): void;
  registerFlag(flag: ExtensionFlag): void;
  appendEntry(type: string, data?: unknown): Promise<void>;
}

export type ExtensionTeardown = () => unknown;

export type ExtensionFactory = (api: ExtensionApi) => unknown;

export interface ExtensionDefinition {
  name: string;
  source: ExtensionSource;
  file?: string;
  activate: ExtensionFactory;
}

export type ExtensionLogLevel = "info" | "warn" | "error";

export interface ExtensionLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ExtensionCommand {
  name: string;
  description?: string;
  run(args: string): unknown;
}

export interface ExtensionShortcut {
  keys: string;
  description?: string;
  run(): unknown;
}

export interface ExtensionFlag {
  name: string;
  description?: string;
  takesValue?: boolean;
}

export type ToolCallDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; arguments: unknown };

export interface ToolResultReport {
  callId: string;
  call: ToolCallPart | undefined;
  output: string;
  isError: boolean;
}

export interface CustomEntryDelivery {
  type: string;
  data: unknown;
  replay: boolean;
}

interface Hook<Payload, Result = unknown> {
  payload: Payload;
  result: Result;
}

type Empty = Record<never, never>;

export interface Hooks {
  session_start: Hook<{ reason: SessionStartReason }>;
  session_end: Hook<{ reason: SessionEndReason }>;
  turn_start: Hook<{ userText: string }>;
  turn_end: Hook<{ message: Message; interrupted: boolean }>;
  message_appended: Hook<{ message: Message }>;
  tool_call: Hook<{ call: ToolCallPart }, ToolCallDecision | undefined>;
  tool_result: Hook<ToolResultReport>;
  context: Hook<{ systemPrompt: string }, string | undefined>;
  custom_entry: Hook<CustomEntryDelivery>;
  session_before_fork: Hook<{ fromEntryId: string }>;
  session_before_compact: Hook<{ tokensBefore: number }>;
  session_compact: Hook<{ summary: string }>;
  session_tree: Hook<{ leafId: string | null }>;
  before_agent_start: Hook<{ systemPrompt: string }>;
  agent_start: Hook<Empty>;
  agent_end: Hook<{ messages: readonly Message[] }>;
  agent_settled: Hook<Empty>;
  message_start: Hook<{ message: Message }>;
  message_update: Hook<{ message: Message; delta: TurnDelta }>;
  message_end: Hook<{ message: Message }>;
  input: Hook<{ text: string }, { text: string } | undefined>;
  tool_execution_start: Hook<{ call: ToolCallPart }>;
  tool_execution_update: Hook<{ call: ToolCallPart; chunk: string }>;
  tool_execution_end: Hook<{ call: ToolCallPart; output: string; isError: boolean }>;
  before_provider_request: Hook<{ request: ProviderRequest }>;
  after_provider_response: Hook<{ usage: Usage }>;
  model_select: Hook<{ modelId: string }>;
  user_bash: Hook<{ command: string }>;
  project_trust: Hook<{ cwd: string; trusted: boolean }>;
  resources_discover: Hook<{ cwd: string }, { files: string[] } | undefined>;
}

export type HookName = keyof Hooks;
export type HookPayload<K extends HookName> = Hooks[K]["payload"];
export type HookResult<K extends HookName> = Hooks[K]["result"];

export type HookHandler<K extends HookName> = (
  payload: HookPayload<K>,
) => HookResult<K> | undefined | Promise<HookResult<K> | undefined>;

export type HookHandlers = { [K in HookName]: HookHandler<K> };

export const wiredHooks = [
  "session_start",
  "session_end",
  "turn_start",
  "turn_end",
  "message_appended",
  "tool_call",
  "tool_result",
  "context",
  "custom_entry",
] as const satisfies readonly HookName[];

export const typedOnlyHooks = [
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_tree",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_start",
  "message_update",
  "message_end",
  "input",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "before_provider_request",
  "after_provider_response",
  "model_select",
  "user_bash",
  "project_trust",
  "resources_discover",
] as const satisfies readonly HookName[];

export type WiredHook = (typeof wiredHooks)[number];
export type TypedOnlyHook = (typeof typedOnlyHooks)[number];

type Unclassified = Exclude<HookName, WiredHook | TypedOnlyHook>;
type DoublyClassified = Extract<WiredHook, TypedOnlyHook>;

export const everyHookIsClassifiedOnce: [Unclassified | DoublyClassified] extends [never]
  ? true
  : never = true;

export function isWiredHook(hook: HookName): hook is WiredHook {
  return (wiredHooks as readonly HookName[]).includes(hook);
}
