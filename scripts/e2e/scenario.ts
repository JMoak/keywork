import type { Tool, TurnDelta } from "../../packages/engine/src/index.ts";
import type { PresetsPort } from "../../packages/tui/src/index.ts";

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface CaptureOptions {
  readonly golden?: boolean;
}

export interface Stage {
  readonly workspaceDir: string;
  readonly sessionDir: string;
  press(...chords: readonly string[]): Promise<void>;
  type(text: string): Promise<void>;
  settle(): Promise<void>;
  until(marker: string, timeoutMs?: number): Promise<string>;
  capture(stepName: string, options?: CaptureOptions): Promise<string>;
  evidence(fileName: string, content: string): string;
  resize(width: number, height: number): Promise<void>;
  relaunch(): Promise<void>;
  quit(): Promise<number>;
}

export interface WorldPaths {
  readonly workspaceDir: string;
  readonly sessionDir: string;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly manual?: boolean;
  readonly size?: FrameSize;
  readonly files?: Readonly<Record<string, string>>;
  readonly turns?: readonly TurnDelta[][];
  readonly tools?: (workspaceDir: string) => Tool[];
  readonly provider?: "mock" | "none";
  readonly presets?: (stateDir: string) => PresetsPort;
  beforeBoot?(world: WorldPaths): void;
  run(stage: Stage): Promise<void>;
}
