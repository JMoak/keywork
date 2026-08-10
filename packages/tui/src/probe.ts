import { Agent, MockProvider, type TurnDelta } from "@keywork/engine";
import { AppCore, type AppSnapshot } from "./app-core.ts";
import type { BrowserModel } from "./browser-model.ts";
import { BrowserPane } from "./browser-pane.ts";
import type { CommandRegistry } from "./commands.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { type Chord, parseChord } from "./keys.ts";
import type { Rect, Screen } from "./layout.ts";
import type { Pane, PaneIntents } from "./pane.ts";
import type { PointerEvent, ScrollDirection } from "./pointer.ts";

export type PaneFactory = (id: string, notify: () => void, commands: CommandRegistry) => Pane;

export interface AppProbeOptions {
  screen?: Screen;
  script?: TurnDelta[][];
  createPane?: PaneFactory;
  createFilePane?: (id: string, path: string, notify: () => void) => Pane;
  createBrowserPane?: (id: string, root: string, notify: () => void, intents: PaneIntents) => Pane;
  isDirectory?: (path: string) => boolean;
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
      ...(options.isDirectory !== undefined && { isDirectory: options.isDirectory }),
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

  scroll(x: number, y: number, direction: ScrollDirection, delta = 1): this {
    this.point({ type: "scroll", x, y, scroll: { direction, delta } });
    return this;
  }

  rect(id: string): Rect | undefined {
    return this.core.layout.rects(this.screen).get(id);
  }

  snapshot(): AppSnapshot {
    return this.core.snapshot();
  }

  model(id = this.core.snapshot().focused): ConversationModel | undefined {
    const pane = id === undefined ? undefined : this.core.panes.get(id);
    return pane instanceof ConversationPane ? modelOf(pane) : undefined;
  }

  async settled(): Promise<this> {
    for (const pane of this.snapshot().panes) {
      await this.model(pane.id)?.lastSend;
      const candidate = this.core.panes.get(pane.id);
      if (candidate instanceof BrowserPane) await browserModelOf(candidate).settled();
    }
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
  return (id, notify, commands) => {
    const agent =
      script === undefined ? undefined : new Agent({ provider: new MockProvider(script) });
    return new ConversationPane(id, agent, notify, undefined, commands);
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

function browserModelOf(pane: BrowserPane): BrowserModel {
  return (pane as unknown as { model: BrowserModel }).model;
}
