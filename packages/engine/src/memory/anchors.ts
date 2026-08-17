import { hostname } from "node:os";
import type { Frontmatter } from "./frontmatter.ts";

export interface CheckpointAnchor {
  at: string;
  sha?: string | undefined;
  checkpoint?: string | undefined;
}

export interface CheckpointAnchorInputs {
  now: Date;
  sha?: string | undefined;
  checkpointId?: string | undefined;
  host?: string | undefined;
}

export function checkpointAnchor(inputs: CheckpointAnchorInputs): CheckpointAnchor {
  const host = inputs.host ?? hostname();
  return {
    at: inputs.now.toISOString(),
    ...(inputs.sha !== undefined && { sha: inputs.sha }),
    ...(inputs.checkpointId !== undefined && { checkpoint: `${host}:${inputs.checkpointId}` }),
  };
}

export function anchorFrontmatter(anchor: CheckpointAnchor): Frontmatter {
  return {
    anchored_at: anchor.at,
    ...(anchor.sha !== undefined && { anchor_sha: anchor.sha }),
    ...(anchor.checkpoint !== undefined && { anchor_checkpoint: anchor.checkpoint }),
  };
}

export function readAnchor(
  frontmatter: Frontmatter,
  localHost: string = hostname(),
): CheckpointAnchor | undefined {
  const at = frontmatter.anchored_at;
  if (typeof at !== "string" || at === "") return undefined;
  const sha = frontmatter.anchor_sha;
  const checkpoint = localCheckpoint(frontmatter.anchor_checkpoint, localHost);
  return {
    at,
    ...(typeof sha === "string" && sha !== "" && { sha }),
    ...(checkpoint !== undefined && { checkpoint }),
  };
}

function localCheckpoint(value: unknown, localHost: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const divide = value.indexOf(":");
  if (divide <= 0) return undefined;
  return value.slice(0, divide) === localHost ? value : undefined;
}
