import type { McpServerStatus } from "@keywork/engine";
import type { KeyworkClient } from "@keywork/server";

export type RunningServer = Pick<KeyworkClient, "restartMcpServer">;

export type RunningServerSeam = () => Promise<RunningServer | undefined>;

export type ReconnectOutcome =
  | { kind: "reconnected"; status: McpServerStatus | undefined }
  | { kind: "no-server" }
  | { kind: "failed"; reason: string };

export async function reconnectOnRunningServer(
  name: string,
  server: RunningServer | undefined,
): Promise<ReconnectOutcome> {
  if (server === undefined) return { kind: "no-server" };
  try {
    return { kind: "reconnected", status: await server.restartMcpServer(name) };
  } catch (cause) {
    return { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function describeReconnect(name: string, outcome: ReconnectOutcome): string {
  switch (outcome.kind) {
    case "reconnected":
      return `${name} reconnected on the running keywork server · ${describeStatus(outcome.status)}`;
    case "no-server":
      return `no keywork server is running for this workspace · restart ${name} from the mcp pane, or relaunch keywork, to use it`;
    case "failed":
      return `the running keywork server could not reconnect ${name} (${outcome.reason}) · restart it from the mcp pane`;
  }
}

function describeStatus(status: McpServerStatus | undefined): string {
  if (status === undefined) return "status unknown";
  const facts = [
    status.state,
    ...(status.auth === undefined
      ? []
      : [status.auth === "signed-in" ? "signed in" : "sign-in needed"]),
    ...(status.lastError === undefined ? [] : [status.lastError]),
  ];
  return facts.join(" · ");
}
