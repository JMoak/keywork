import { rmSync } from "node:fs";
import { jsonFileStore } from "@keywork/shared";
import type { PortRange } from "./config.ts";

export const nodeFileSchema = 1;

export type NodeState = "running" | "stopped";

export type UnitState = "starting" | "running" | "backing-off" | "adopted" | "parked" | "stopped";

export interface UnitView {
  state: UnitState;
  pid: number | null;
  restarts: number;
  since: string | null;
}

export interface WorkspaceView extends UnitView {
  cwd: string;
  slug: string | null;
  identity: string;
  ticket: string;
  url: string | null;
}

export interface NodeStop {
  at: string;
  reason: string;
  item: string | null;
}

export interface NodeFile {
  schema: typeof nodeFileSchema;
  state: NodeState;
  version: string;
  contract?: string;
  machine: { id: string; name: string };
  pid: number | null;
  startedAt: string;
  updatedAt: string;
  ports: { mesh: number | null; screenUdp: PortRange | null };
  workspaces: WorkspaceView[];
  core: UnitView;
  logs: { node: string; lifecycle: string };
  stopped: NodeStop | null;
}

export interface NodeFileStore {
  readonly file: string;
  read(): NodeFile | undefined;
  write(node: NodeFile): void;
  remove(): void;
}

export function nodeFileStore(file: string): NodeFileStore {
  const store = jsonFileStore<NodeFile>({ file, mode: "lenient", validate: asNodeFile });
  return {
    file,
    read: () => {
      try {
        return store.read();
      } catch {
        return undefined;
      }
    },
    write: (node) => store.write(node),
    remove: () => rmSync(file, { force: true }),
  };
}

function asNodeFile(data: unknown): NodeFile {
  const candidate = data as Partial<NodeFile> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    candidate.schema !== nodeFileSchema ||
    !Array.isArray(candidate.workspaces)
  ) {
    throw new Error("not a node.json this keywork understands");
  }
  return candidate as NodeFile;
}
