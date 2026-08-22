import type { Tool, TurnDelta } from "../../packages/engine/src/index.ts";
import type { AgentFactory, Flavor, PresetsPort } from "../../packages/tui/src/index.ts";

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Stage {
  readonly workspaceDir: string;
  readonly sessionDir: string;
  press(...chords: readonly string[]): Promise<void>;
  type(text: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, direction: "up" | "down", times?: number): Promise<void>;
  drag(from: Point, to: Point): Promise<void>;
  settle(): Promise<void>;
  until(marker: string, timeoutMs?: number): Promise<string>;
  capture(stepName: string): Promise<string>;
  evidence(fileName: string, content: string): string;
  resize(width: number, height: number): Promise<void>;
  renderOnce(): Promise<number>;
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
  readonly agentFactory?: AgentFactory;
  readonly script?: "per-agent" | "shared";
  readonly contextWindow?: number;
  readonly flavors?: readonly Flavor[];
  readonly presets?: (stateDir: string) => PresetsPort;
  readonly goldens?: readonly string[];
  beforeBoot?(world: WorldPaths): void;
  run(stage: Stage): Promise<void>;
}
