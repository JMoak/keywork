import { Agent, MockProvider, type TurnDelta } from "@keywork/engine";
import { AppCore, type AppCoreOptions, type AppSnapshot, type PaneFactory } from "./app-core.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { type Chord, parseChord } from "./keys.ts";
import type { Rect, Screen } from "./layout.ts";
import type { PointerEvent, ScrollDirection } from "./pointer.ts";
import type { WorkspaceState } from "./workspace-state.ts";

export interface AppProbeOptions
  extends Partial<
    Pick<
      AppCoreOptions,
      | "createPane"
      | "createFilePane"
      | "createBrowserPane"
      | "createSessionTreePane"
      | "createArcsPane"
      | "createMemoryPane"
      | "createMcpPane"
      | "isDirectory"
      | "undo"
      | "presets"
      | "inference"
      | "connections"
      | "arcs"
      | "focusedArc"
      | "workspaces"
      | "currentModel"
      | "switchModel"
      | "restoreWorkspace"
      | "saveWorkspace"
      | "onPaneClosed"
    >
  > {
  screen?: Screen;
  script?: TurnDelta[][];
}

export class AppProbe {
  readonly core: AppCore;
  readonly screen: Screen;
  exited = false;
  private clockMs = 0;

  constructor(options: AppProbeOptions = {}) {
    this.screen = options.screen ?? { width: 120, height: 40 };
    const screen = this.screen;
    this.core = new AppCore({
      screen: () => screen,
      createPane: options.createPane ?? conversationPanes(options.script),
      ...(options.createFilePane !== undefined && { createFilePane: options.createFilePane }),
      ...(options.createBrowserPane !== undefined && {
        createBrowserPane: options.createBrowserPane,
      }),
      ...(options.createSessionTreePane !== undefined && {
        createSessionTreePane: options.createSessionTreePane,
      }),
      ...(options.createArcsPane !== undefined && { createArcsPane: options.createArcsPane }),
      ...(options.createMemoryPane !== undefined && {
        createMemoryPane: options.createMemoryPane,
      }),
      ...(options.createMcpPane !== undefined && {
        createMcpPane: options.createMcpPane,
      }),
      ...(options.isDirectory !== undefined && { isDirectory: options.isDirectory }),
      ...(options.undo !== undefined && { undo: options.undo }),
      ...(options.presets !== undefined && { presets: options.presets }),
      ...(options.inference !== undefined && { inference: options.inference }),
      ...(options.connections !== undefined && { connections: options.connections }),
      ...(options.arcs !== undefined && { arcs: options.arcs }),
      ...(options.focusedArc !== undefined && { focusedArc: options.focusedArc }),
      ...(options.workspaces !== undefined && { workspaces: options.workspaces }),
      ...(options.currentModel !== undefined && { currentModel: options.currentModel }),
      ...(options.switchModel !== undefined && { switchModel: options.switchModel }),
      ...(options.restoreWorkspace !== undefined && {
        restoreWorkspace: options.restoreWorkspace,
      }),
      ...(options.saveWorkspace !== undefined && { saveWorkspace: options.saveWorkspace }),
      ...(options.onPaneClosed !== undefined && { onPaneClosed: options.onPaneClosed }),
      onExit: () => {
        this.exited = true;
      },
    });
    this.core.start();
  }

  keys(...specs: string[]): this {
    for (const spec of specs) this.press(parseChord(spec), spec.length === 1 ? spec : undefined);
    return this;
  }

  type(text: string): this {
    for (const character of text) this.press(printableChord(character), character);
    return this;
  }

  repeat(spec: string): this {
    this.clockMs += 1;
    this.core.handleKey(parseChord(spec), undefined, this.clockMs, true);
    return this;
  }

  paste(text: string): this {
    this.clockMs += 1;
    this.core.handlePaste(text);
    return this;
  }

  command(name: string): boolean {
    return this.core.runCommand(name);
  }

  click(x: number, y: number): this {
    this.point({ type: "down", x, y, button: 0 });
    this.point({ type: "up", x, y, button: 0 });
    return this;
  }

  hover(x: number, y: number): this {
    this.point({ type: "move", x, y });
    return this;
  }

  drag(from: { x: number; y: number }, ...path: { x: number; y: number }[]): this {
    this.point({ type: "down", x: from.x, y: from.y, button: 0 });
    for (const at of path) this.point({ type: "drag", x: at.x, y: at.y, button: 0 });
    const last = path.at(-1) ?? from;
    this.point({ type: "up", x: last.x, y: last.y, button: 0 });
    return this;
  }

  scroll(x: number, y: number, direction: ScrollDirection, delta = 1): this {
    this.point({ type: "scroll", x, y, scroll: { direction, delta } });
    return this;
  }

  rect(id: string): Rect {
    const rect = this.core.layout.rects(this.screen).get(id);
    if (rect === undefined) throw new Error(`no pane rect for "${id}"`);
    return rect;
  }

  snapshot(): AppSnapshot {
    return this.core.snapshot();
  }

  workspaceState(): WorkspaceState {
    return this.core.workspaceState();
  }

  model(id = this.core.snapshot().focused): ConversationModel | undefined {
    const pane = id === undefined ? undefined : this.core.panes.get(id);
    return pane instanceof ConversationPane ? modelOf(pane) : undefined;
  }

  async settled(): Promise<this> {
    for (const pane of this.core.panes.values()) await pane.settled?.();
    return this;
  }

  private press(chord: Chord, sequence: string | undefined): void {
    this.clockMs += 1;
    this.core.handleKey(chord, sequence, this.clockMs);
  }

  private point(event: PointerEvent): void {
    this.clockMs += 1;
    this.core.handleMouse(event, this.clockMs);
  }
}

function conversationPanes(script: TurnDelta[][] | undefined): PaneFactory {
  return (id, notify, commands, _resumeSessionId, draft) => {
    const agent =
      script === undefined ? undefined : new Agent({ provider: new MockProvider(script) });
    return new ConversationPane(id, agent, notify, undefined, commands, {
      ...(draft !== undefined && { initialDraft: draft }),
    });
  };
}

function printableChord(character: string): Chord {
  return {
    name: character === " " ? "space" : character.toLowerCase(),
    ctrl: false,
    shift: false,
    meta: false,
  };
}

function modelOf(pane: ConversationPane): ConversationModel {
  return (pane as unknown as { model: ConversationModel }).model;
}
