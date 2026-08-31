import type { SendBehavior } from "@keywork/engine";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import { isPrintable } from "./picker-keys.ts";

export interface CommandSuggestion {
  name: string;
  description: string;
  shortcut?: string;
}

export interface CommandsPort {
  search(query: string): readonly CommandSuggestion[];
  run(name: string): boolean;
}

export type EditorOutcome =
  | "handled"
  | "pass"
  | { submit: string; behavior: SendBehavior }
  | { command: string; chosen: string | undefined };

export class PromptEditor {
  readonly buffer = new InputBuffer();
  selectedSuggestion = 0;
  private readonly history: string[] = [];
  private historyIndex: number | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly builtIn: readonly CommandSuggestion[],
    private readonly commands?: CommandsPort,
  ) {}

  get value(): string {
    return this.buffer.value;
  }

  isEmpty(): boolean {
    return this.buffer.isEmpty();
  }

  load(text: string): void {
    this.buffer.load(text);
  }

  clear(): void {
    this.buffer.clear();
    this.historyIndex = undefined;
    this.selectedSuggestion = 0;
    this.notify();
  }

  paste(text: string): void {
    this.edit(() => this.buffer.insert(text.replace(/\r\n?/g, "\n")));
  }

  remember(text: string): void {
    if (this.history.at(-1) === text) return;
    this.history.push(text);
    if (this.history.length > historyLimit) this.history.shift();
  }

  slashQuery(): string | undefined {
    return this.value.startsWith("/") ? this.value.slice(1) : undefined;
  }

  suggestions(): readonly CommandSuggestion[] {
    const query = this.slashQuery();
    if (query === undefined) return [];
    const needle = query.trim().toLowerCase();
    const local = this.builtIn.filter(({ name }) => name.startsWith(needle));
    const port = this.commands?.search(query) ?? [];
    const localLeads = needle !== "" && local.length > 0;
    const merged = localLeads ? [...local, ...port] : [...port, ...local];
    return merged.slice(0, suggestionLimit);
  }

  handleKey(chord: Chord, sequence: string | undefined): EditorOutcome {
    if (this.slashQuery() !== undefined) {
      const slashed = this.handleSlashKey(chord);
      if (slashed !== "pass") return slashed;
    }
    switch (chord.name) {
      case "return":
      case "enter": {
        if (chord.shift) return this.edit(() => this.buffer.newline());
        const text = this.value.trim();
        if (text === "") return "handled";
        return { submit: text, behavior: chord.meta ? "steer" : "queue" };
      }
      case "backspace":
        return this.edit(() => this.buffer.backspace());
      case "left":
        return this.moved(() => this.buffer.left());
      case "right":
        return this.moved(() => this.buffer.right());
      case "home":
        return this.moved(() => this.buffer.home());
      case "end":
        return this.moved(() => this.buffer.end());
      case "up":
        return this.lineUpOrHistory(-1);
      case "down":
        return this.lineUpOrHistory(1);
      default:
        if (!isPrintable(chord, sequence)) return "pass";
        return this.edit(() => this.buffer.insert(sequence));
    }
  }

  private handleSlashKey(chord: Chord): EditorOutcome {
    switch (chord.name) {
      case "escape":
        this.buffer.clear();
        this.selectedSuggestion = 0;
        this.notify();
        return "handled";
      case "up":
      case "down": {
        const count = Math.max(1, this.suggestions().length);
        const step = chord.name === "down" ? 1 : -1;
        this.selectedSuggestion = (this.selectedSuggestion + step + count) % count;
        this.notify();
        return "handled";
      }
      case "tab": {
        const chosen = this.suggestions()[this.selectedSuggestion];
        if (chosen !== undefined) this.buffer.load(`/${chosen.name}`);
        this.notify();
        return "handled";
      }
      case "return":
      case "enter": {
        const command = this.value.slice(1).trim();
        const chosen = this.suggestions()[this.selectedSuggestion]?.name;
        this.buffer.clear();
        this.selectedSuggestion = 0;
        this.notify();
        return { command, chosen };
      }
      default:
        return "pass";
    }
  }

  private lineUpOrHistory(direction: -1 | 1): EditorOutcome {
    if (this.historyIndex === undefined) {
      const moved = direction === -1 ? this.buffer.up() : this.buffer.down();
      if (moved) {
        this.notify();
        return "handled";
      }
    }
    return this.browseHistory(direction);
  }

  private browseHistory(direction: -1 | 1): EditorOutcome {
    if (direction === -1) {
      if (this.historyIndex === undefined) {
        if (!this.buffer.isEmpty() || this.history.length === 0) return "pass";
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      return this.recallHistory();
    }
    if (this.historyIndex === undefined) return "pass";
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      return this.recallHistory();
    }
    this.historyIndex = undefined;
    this.buffer.clear();
    this.notify();
    return "handled";
  }

  private recallHistory(): EditorOutcome {
    this.buffer.load(this.history[this.historyIndex ?? -1] ?? "");
    this.notify();
    return "handled";
  }

  private edit(change: () => void): EditorOutcome {
    change();
    this.historyIndex = undefined;
    this.selectedSuggestion = 0;
    this.notify();
    return "handled";
  }

  private moved(move: () => void): EditorOutcome {
    move();
    this.notify();
    return "handled";
  }
}

const suggestionLimit = 5;
const historyLimit = 50;
