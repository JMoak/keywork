import type { McpServerStatus, McpStatusListener, McpTool } from "@keywork/engine";
import type { McpPanePort, McpServerView } from "@keywork/tui";

export interface McpRegistryLike {
  status(): McpServerStatus[];
  subscribe(listener: McpStatusListener): () => void;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  listTools(name: string): McpTool[];
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

function serverView(status: McpServerStatus): McpServerView {
  return {
    name: status.name,
    state: status.state,
    toolCount: status.toolCount,
    enabled: status.enabled,
    ...(status.lastError !== undefined && { lastError: status.lastError }),
  };
}
