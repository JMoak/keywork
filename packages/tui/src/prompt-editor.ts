import type { SendBehavior } from "@keywork/engine";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import {
  insertedMention,
  type MentionSource,
  type MentionToken,
  mentionAt,
  rankMentions,
} from "./mention-completer.ts";
import { PasteVault } from "./paste-placeholder.ts";
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
  private readonly pastes = new PasteVault();
  private readonly history: string[] = [];
  private historyIndex: number | undefined;
  private clearedDraft: ClearedDraft | undefined;
  private dismissedMention: number | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly builtIn: readonly CommandSuggestion[],
    private readonly commands?: CommandsPort,
    private readonly mentions?: MentionSource,
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
    if (this.onClearedDraft()) this.clearedDraft = undefined;
    this.buffer.clear();
    this.pastes.clear();
    this.historyIndex = undefined;
    this.selectedSuggestion = 0;
    this.notify();
  }

  clearKeepingDraft(): EditorOutcome {
    if (this.buffer.isEmpty()) return "pass";
    this.clearedDraft = { text: this.value, pastes: this.pastes.snapshot() };
    this.historyIndex = undefined;
    this.clear();
    return "handled";
  }

  paste(text: string): void {
    const normalized = text.replace(/\r\n?/g, "\n");
    this.edit(() => this.buffer.insert(this.pastes.collapse(normalized)));
  }

  expandPlaceholderAtCursor(): boolean {
    const span = this.pastes.spanAt(this.value, this.buffer.cursorOffset);
    const full = span === undefined ? undefined : this.pastes.textOf(span.ordinal);
    if (span === undefined || full === undefined) return false;
    this.edit(() => this.buffer.replaceRange(span.start, span.end, full));
    return true;
  }

  remember(text: string): void {
    if (this.history.at(-1) === text) return;
    this.history.push(text);
    if (this.history.length > historyLimit) this.history.shift();
  }

  slashQuery(): string | undefined {
    return this.value.startsWith("/") ? this.value.slice(1) : undefined;
  }

  mentionQuery(): MentionToken | undefined {
    if (this.mentions === undefined || this.slashQuery() !== undefined) return undefined;
    const token = mentionAt(this.value, this.buffer.cursorOffset);
    return token === undefined || token.start === this.dismissedMention ? undefined : token;
  }

  completing(): boolean {
    return this.slashQuery() !== undefined || this.mentionSuggestions().length > 0;
  }

  suggestions(): readonly CommandSuggestion[] {
    const query = this.slashQuery();
    if (query === undefined) return this.mentionSuggestions();
    const needle = query.trim().toLowerCase();
    const local = this.builtIn.filter(({ name }) => name.startsWith(needle));
    const port = this.commands?.search(query) ?? [];
    const localLeads = needle !== "" && local.length > 0;
    const merged = localLeads ? [...local, ...port] : [...port, ...local];
    return merged.slice(0, suggestionLimit);
  }

  selectSuggestion(at: number): void {
    const count = this.suggestions().length;
    if (count === 0) return;
    this.selectedSuggestion = ((at % count) + count) % count;
    this.notify();
  }

  acceptSuggestion(at: number): EditorOutcome {
    this.selectedSuggestion = at;
    if (this.slashQuery() !== undefined) return this.chooseSelected();
    const mention = this.mentionQuery();
    return mention === undefined ? "pass" : this.insertSelectedMention(mention);
  }

  handleKey(chord: Chord, sequence: string | undefined): EditorOutcome {
    if (isClearChord(chord)) return this.clearKeepingDraft();
    if (this.slashQuery() !== undefined) {
      const slashed = this.handleSlashKey(chord);
      if (slashed !== "pass") return slashed;
    }
    const mention = this.mentionQuery();
    if (mention !== undefined) {
      const completed = this.handleMentionKey(chord, mention);
      if (completed !== "pass") return completed;
    }
    switch (chord.name) {
      case "return":
      case "enter": {
        if (chord.shift) return this.edit(() => this.buffer.newline());
        const text = this.pastes.expandAll(this.value).trim();
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
      case "enter":
        return this.chooseSelected();
      default:
        return "pass";
    }
  }

  private handleMentionKey(chord: Chord, mention: MentionToken): EditorOutcome {
    if (chord.ctrl || chord.meta || chord.shift) return "pass";
    switch (chord.name) {
      case "escape":
        this.dismissedMention = mention.start;
        this.selectedSuggestion = 0;
        this.notify();
        return "handled";
      case "up":
      case "down":
        return this.cycleMention(chord.name === "down" ? 1 : -1);
      case "tab":
        return this.insertSelectedMention(mention);
      case "return":
      case "enter":
        return this.mentionComplete(mention) ? "pass" : this.insertSelectedMention(mention);
      default:
        return "pass";
    }
  }

  private cycleMention(step: 1 | -1): EditorOutcome {
    const count = this.mentionSuggestions().length;
    if (count === 0) return "pass";
    this.selectedSuggestion = (this.selectedSuggestion + step + count) % count;
    this.notify();
    return "handled";
  }

  private mentionComplete(mention: MentionToken): boolean {
    return this.mentionSuggestions()[this.selectedSuggestion]?.name === mention.query;
  }

  private insertSelectedMention(mention: MentionToken): EditorOutcome {
    const chosen = this.mentionSuggestions()[this.selectedSuggestion];
    if (chosen === undefined) return "pass";
    return this.edit(() =>
      this.buffer.replaceRange(mention.start, mention.end, insertedMention(chosen.name)),
    );
  }

  private mentionSuggestions(): readonly CommandSuggestion[] {
    const mention = this.mentionQuery();
    const files = this.mentions;
    if (mention === undefined || files === undefined) return [];
    return rankMentions(mention.query, files(), suggestionLimit).map((path) => ({
      name: path,
      description: "",
    }));
  }

  private chooseSelected(): EditorOutcome {
    const command = this.value.slice(1).trim();
    const chosen = this.suggestions()[this.selectedSuggestion]?.name;
    this.buffer.clear();
    this.selectedSuggestion = 0;
    this.notify();
    return { command, chosen };
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
    const newest = this.newestRecallSlot();
    if (direction === -1) {
      if (this.historyIndex === undefined) {
        if (!this.buffer.isEmpty() || newest < 0) return "pass";
        this.historyIndex = newest;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      return this.recallHistory();
    }
    if (this.historyIndex === undefined) return "pass";
    if (this.historyIndex < newest) {
      this.historyIndex += 1;
      return this.recallHistory();
    }
    this.historyIndex = undefined;
    this.buffer.clear();
    this.notify();
    return "handled";
  }

  private newestRecallSlot(): number {
    return this.clearedDraft === undefined ? this.history.length - 1 : this.history.length;
  }

  private onClearedDraft(): boolean {
    return this.recalledDraft() !== undefined;
  }

  private recalledDraft(): ClearedDraft | undefined {
    return this.historyIndex === this.history.length ? this.clearedDraft : undefined;
  }

  private recallHistory(): EditorOutcome {
    const draft = this.recalledDraft();
    if (draft !== undefined) {
      this.buffer.load(draft.text);
      this.pastes.restore(draft.pastes);
    } else {
      this.buffer.load(this.history[this.historyIndex ?? -1] ?? "");
    }
    this.notify();
    return "handled";
  }

  private edit(change: () => void): EditorOutcome {
    change();
    if (this.onClearedDraft()) this.clearedDraft = undefined;
    if (mentionAt(this.value, this.buffer.cursorOffset)?.start !== this.dismissedMention) {
      this.dismissedMention = undefined;
    }
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

interface ClearedDraft {
  readonly text: string;
  readonly pastes: ReadonlyMap<number, string>;
}

function isClearChord(chord: Chord): boolean {
  return chord.ctrl && !chord.meta && !chord.shift && chord.name === "c";
}

const suggestionLimit = 5;
const historyLimit = 50;
