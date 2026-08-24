import type { TranscriptEntry, UserEntry } from "./transcript-feed.ts";
import type { Viewport } from "./transcript-view.ts";

export interface NavigableFeed {
  readonly entries: readonly TranscriptEntry[];
  promptIndices(): number[];
  disclosableIndices(): number[];
  toggleFold(entry: TranscriptEntry): boolean;
  toggleLatestFold(): boolean;
}

export class TranscriptNavigation {
  scrollBack = 0;
  private backtrackAt: number | undefined;
  private foldCursor: number | undefined;
  private revealAt: number | undefined;
  private escapePrimed = false;

  constructor(
    private readonly feed: NavigableFeed,
    private readonly notify: () => void,
  ) {}

  viewport(): Viewport {
    return {
      scrollBack: this.scrollBack,
      ...(this.revealAt !== undefined && { revealAt: this.revealAt }),
      ...(this.backtrackAt !== undefined && { backtrackAt: this.backtrackAt }),
      ...(this.foldCursor !== undefined && { foldCursor: this.foldCursor }),
    };
  }

  framed(scrollBack: number): void {
    this.scrollBack = scrollBack;
    this.revealAt = undefined;
  }

  scrollBy(delta: number): boolean {
    this.scrollBack = Math.max(0, this.scrollBack + delta);
    this.notify();
    return true;
  }

  snapToLive(): boolean {
    return this.scrollBy(-this.scrollBack);
  }

  primeEscape(): void {
    this.escapePrimed = true;
  }

  takeEscapePrime(): boolean {
    const primed = this.escapePrimed;
    this.escapePrimed = false;
    return primed;
  }

  backtracking(): boolean {
    return this.backtrackAt !== undefined;
  }

  enterBacktrack(): boolean {
    const newest = this.feed.promptIndices().at(-1);
    if (newest === undefined) return false;
    this.reveal(newest, "backtrack");
    return true;
  }

  stepBacktrack(direction: -1 | 1): void {
    const prompts = this.feed.promptIndices();
    const position = prompts.indexOf(this.backtrackAt ?? -1);
    const next = position + direction;
    if (position === -1 || next >= prompts.length) {
      this.exitBacktrack();
      return;
    }
    const target = prompts[next];
    if (target !== undefined) this.reveal(target, "backtrack");
  }

  selectedPrompt(): UserEntry | undefined {
    const entry = this.backtrackAt === undefined ? undefined : this.feed.entries[this.backtrackAt];
    return entry?.kind === "user" ? entry : undefined;
  }

  exitBacktrack(): void {
    this.backtrackAt = undefined;
    this.revealAt = undefined;
    this.scrollBack = 0;
    this.notify();
  }

  disclosing(): boolean {
    return this.foldCursor !== undefined;
  }

  stepFoldCursor(): boolean {
    const disclosable = this.feed.disclosableIndices();
    if (disclosable.length === 0) return false;
    const position = disclosable.indexOf(this.foldCursor ?? -1);
    const older = position <= 0 ? disclosable.length - 1 : position - 1;
    const target = disclosable[older];
    if (target !== undefined) this.reveal(target, "fold");
    return true;
  }

  toggleCursoredFold(): boolean {
    const cursored = this.foldCursor === undefined ? undefined : this.feed.entries[this.foldCursor];
    return cursored === undefined ? this.feed.toggleLatestFold() : this.feed.toggleFold(cursored);
  }

  exitDisclosure(): void {
    this.foldCursor = undefined;
    this.scrollBack = 0;
    this.notify();
  }

  reset(): void {
    this.backtrackAt = undefined;
    this.foldCursor = undefined;
    this.revealAt = undefined;
    this.escapePrimed = false;
  }

  private reveal(at: number, as: "backtrack" | "fold"): void {
    if (as === "backtrack") this.backtrackAt = at;
    else this.foldCursor = at;
    this.revealAt = at;
    this.notify();
  }
}
