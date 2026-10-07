import type { PtyChild, PtySize, PtySupport } from "@keywork/engine";
import type { TerminalSpawner } from "./terminal-model.ts";
import type { TerminalSurface, TerminalSurfaceFactory } from "./terminal-surface.ts";

export type TerminalSize = PtySize;
export type TerminalProcess = PtyChild;

export interface PtyBackend {
  readonly kind: "pty";
  open(cwd: string, size: TerminalSize): TerminalProcess;
  surface(size: TerminalSize): TerminalSurface;
}

export interface PipeBackend {
  readonly kind: "pipes";
  readonly reason: string;
  readonly spawn: TerminalSpawner;
}

export type TerminalBackend = PtyBackend | PipeBackend;

export interface TerminalBackendSeams {
  pty: PtySupport;
  surfaces: TerminalSurfaceFactory | undefined;
  spawn: TerminalSpawner;
}

export const noSurfaceReason = "this renderer has no terminal surface; running the pipe shell";

export function chooseTerminalBackend(seams: TerminalBackendSeams): TerminalBackend {
  const { pty, surfaces, spawn } = seams;
  if (!pty.available) return pipeBackend(pty.reason, spawn);
  if (surfaces === undefined) return pipeBackend(noSurfaceReason, spawn);
  return { kind: "pty", open: pty.open, surface: surfaces };
}

export function pipeBackend(reason: string, spawn: TerminalSpawner): PipeBackend {
  return { kind: "pipes", reason, spawn };
}
