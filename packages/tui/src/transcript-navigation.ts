import type { TranscriptEntry, UserEntry } from "./transcript-feed.ts";
import type { Viewport } from "./transcript-view.ts";

export interface NavigableFeed {
  readonly entries: readonly TranscriptEntry[];
  promptIndices(): number[];
  forgettableIndices(): number[];
  disclosableIndices(): number[];
  toggleFold(entry: TranscriptEntry): boolean;
  toggleLatestFold(): boolean;
}

export type PickerPurpose = "fork" | "forget";

export class TranscriptNavigation {
  scrollBack = 0;
  private framedTotal: number | undefined;
  private backtrackAt: number | undefined;
  private purpose: PickerPurpose = "fork";
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
      ...(this.scrollBack > 0 &&
        this.framedTotal !== undefined && { anchorTotal: this.framedTotal }),
      ...(this.revealAt !== undefined && { revealAt: this.revealAt }),
      ...(this.backtrackAt !== undefined && { backtrackAt: this.backtrackAt }),
      ...(this.foldCursor !== undefined && { foldCursor: this.foldCursor }),
    };
  }

  framed(scrollBack: number, total: number): void {
    this.scrollBack = scrollBack;
    this.framedTotal = total;
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
    return this.enterPicker("fork");
  }

  enterPicker(purpose: PickerPurpose): boolean {
    const newest = this.candidatesFor(purpose).at(-1);
    if (newest === undefined) return false;
    this.purpose = purpose;
    this.reveal(newest, "backtrack");
    return true;
  }

  pickerPurpose(): PickerPurpose | undefined {
    return this.backtracking() ? this.purpose : undefined;
  }

  stepBacktrack(direction: -1 | 1): void {
    const candidates = this.candidatesFor(this.purpose);
    const position = candidates.indexOf(this.backtrackAt ?? -1);
    const next = position + direction;
    if (position === -1 || next >= candidates.length) {
      this.exitBacktrack();
      return;
    }
    const target = candidates[next];
    if (target !== undefined) this.reveal(target, "backtrack");
  }

  selectedPrompt(): UserEntry | undefined {
    const entry = this.selectedEntry();
    return entry?.kind === "user" ? entry : undefined;
  }

  selectedEntry(): TranscriptEntry | undefined {
    return this.backtrackAt === undefined ? undefined : this.feed.entries[this.backtrackAt];
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
    this.framedTotal = undefined;
    this.escapePrimed = false;
  }

  private candidatesFor(purpose: PickerPurpose): number[] {
    return purpose === "fork" ? this.feed.promptIndices() : this.feed.forgettableIndices();
  }

  private reveal(at: number, as: "backtrack" | "fold"): void {
    if (as === "backtrack") this.backtrackAt = at;
    else this.foldCursor = at;
    this.revealAt = at;
    this.notify();
  }
}
