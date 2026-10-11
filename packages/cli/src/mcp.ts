import {
  type FetchLike,
  McpOAuth,
  type McpServerStatus,
  type McpStatusListener,
  type McpTool,
} from "@keywork/engine";
import type { McpServerConfig, SecretVault } from "@keywork/shared";
import type { McpPanePort, McpServerView } from "@keywork/tui";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import {
  describeReconnect,
  type RunningServerSeam,
  reconnectOnRunningServer,
} from "./mcp-reconnect.ts";

export interface McpRegistryLike {
  status(): McpServerStatus[];
  subscribe(listener: McpStatusListener): () => void;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  listTools(name: string): McpTool[];
}

export interface McpCommandOptions extends CommandIo {
  servers: Record<string, McpServerConfig> | undefined;
  vault: SecretVault | undefined;
  fetchFn?: FetchLike;
  loginTimeoutMs?: number;
  runningServer?: RunningServerSeam | undefined;
}

export function mcpPanePort(registry: McpRegistryLike): McpPanePort {
  return {
    load: async () => registry.status().map(serverView),
    restart: (name) => registry.restart(name),
    setEnabled: (name, on) => (on ? registry.enable(name) : registry.disable(name)),
    listTools: async (name) => registry.listTools(name).map((tool) => tool.name),
    subscribe: (listener) => registry.subscribe((statuses) => listener(statuses.map(serverView))),
  };
}

export async function mcpCommand(
  args: readonly string[],
  options: McpCommandOptions,
): Promise<number> {
  const io = resolveCommandIo(options);
  const [verb = "list", name] = args;
  const servers = options.servers ?? {};
  const oauth = new McpOAuth({
    vault: options.vault,
    ...(options.fetchFn !== undefined && { fetchFn: options.fetchFn }),
    ...(options.loginTimeoutMs !== undefined && { loginTimeoutMs: options.loginTimeoutMs }),
  });
  switch (verb) {
    case "list":
      return listServers(servers, oauth, io.print);
    case "login":
    case "logout": {
      const server = httpServerNamed(servers, name, verb);
      if (typeof server === "string") return refuse(server, io.printError);
      return verb === "login"
        ? login(server, oauth, io, options.runningServer)
        : logout(server, oauth, io.print);
    }
    default:
      return refuse(
        `keywork mcp: unknown verb "${verb}" (list · login <server> · logout <server>)`,
        io.printError,
      );
  }
}

interface NamedHttpServer {
  name: string;
  url: string;
}

async function listServers(
  servers: Record<string, McpServerConfig>,
  oauth: McpOAuth,
  print: (line: string) => void,
): Promise<number> {
  const names = Object.keys(servers);
  if (names.length === 0) {
    print("no mcp servers configured");
    return 0;
  }
  for (const name of names) print(await describeServer(name, servers[name], oauth));
  return 0;
}

async function describeServer(
  name: string,
  config: McpServerConfig | undefined,
  oauth: McpOAuth,
): Promise<string> {
  if (config?.transport !== "http") return `${name} · stdio`;
  const signedIn = await oauth.signedIn(config.url).catch(() => false);
  return `${name} · http · ${signedIn ? "signed in" : "not signed in"}`;
}

async function login(
  server: NamedHttpServer,
  oauth: McpOAuth,
  io: { print: (line: string) => void; printError: (line: string) => void },
  runningServer: RunningServerSeam | undefined,
): Promise<number> {
  try {
    const summary = await oauth.login(server.name, server.url, { say: io.print });
    io.print(`signed in to ${server.name} through ${summary.issuer}`);
    const outcome = await reconnectOnRunningServer(server.name, await runningServer?.());
    io.print(describeReconnect(server.name, outcome));
    return 0;
  } catch (cause) {
    io.printError(`keywork mcp login ${server.name}: ${messageOf(cause)}`);
    return 1;
  }
}

async function logout(
  server: NamedHttpServer,
  oauth: McpOAuth,
  print: (line: string) => void,
): Promise<number> {
  const forgotten = await oauth.logout(server.name, server.url);
  print(forgotten ? `signed out of ${server.name}` : `${server.name} had no sign-in to forget`);
  return 0;
}

function httpServerNamed(
  servers: Record<string, McpServerConfig>,
  name: string | undefined,
  verb: string,
): NamedHttpServer | string {
  if (name === undefined) return `keywork mcp ${verb} needs a server name`;
  const config = servers[name];
  if (config === undefined) {
    const known = Object.keys(servers);
    const hint = known.length === 0 ? "no servers are configured" : `known: ${known.join(", ")}`;
    return `keywork mcp ${verb}: no server named "${name}" (${hint})`;
  }
  if (config.transport !== "http")
    return `keywork mcp ${verb}: ${name} runs over stdio and has nothing to sign in to`;
  return { name, url: config.url };
}

function refuse(reason: string, printError: (line: string) => void): number {
  printError(reason);
  return 2;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function serverView(status: McpServerStatus): McpServerView {
  return { ...status };
}
