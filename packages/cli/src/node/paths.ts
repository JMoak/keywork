import { join } from "node:path";
import { keyworkHome, workspaceIdentity } from "../paths.ts";

export interface NodePaths {
  userState: string;
  nodeFile: string;
  state: string;
  config: string;
  opens: string;
  ownership: string;
  mutations: string;
  registry: string;
  runtime: string;
  machineId: string;
  logs: string;
  nodeLog: string;
  lifecycleLog: string;
  stoppedItem: string;
  taskDefinition: string;
}

export function nodePaths(userRoot?: string): NodePaths {
  const userState = keyworkHome(userRoot);
  const state = join(userState, "node");
  const logs = join(state, "logs");
  return {
    userState,
    nodeFile: join(userState, "node.json"),
    state,
    config: join(state, "config.json"),
    opens: join(state, "opens.json"),
    ownership: join(state, "supervisor.sqlite"),
    mutations: join(state, "mutations.sqlite"),
    registry: join(state, "runtime.sqlite"),
    runtime: join(userState, "runtime"),
    machineId: join(state, "machine-id"),
    logs,
    nodeLog: join(logs, "node.log"),
    lifecycleLog: join(logs, "lifecycle.log"),
    stoppedItem: join(state, "desk", "node-stopped.json"),
    taskDefinition: join(state, "task.xml"),
  };
}

export function workspaceStateDir(userRoot: string, cwd: string, slug?: string): string {
  return join(nodePaths(userRoot).state, "workspaces", workspaceIdentity(cwd, slug));
}
