import { toError } from "@keywork/shared";
import {
  type BotDraft,
  type BotEntry,
  type BotScope,
  type BotsPort,
  botSlugProblem,
} from "./bots.ts";
import type { ConnectSpan } from "./connect-model.ts";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import { isEnter } from "./overlays/overlay.ts";
import { isPrintable } from "./picker-keys.ts";

export type BotCreateField = "purpose" | "name" | "scope";

export interface BotCreateSeed {
  slug?: string | undefined;
  purpose?: string | undefined;
}

export interface BotCreateHooks {
  notify(): void;
  notice(text: string): void;
  created(bot: BotEntry): void;
}

export interface BotCreateRow {
  spans: readonly ConnectSpan[];
  selected: boolean;
}

export type BotCreateKeyOutcome = "stay" | "close";

export const botCreateFields: readonly BotCreateField[] = ["purpose", "name", "scope"];

export class BotCreateModel {
  field: BotCreateField = "purpose";
  scope: BotScope = "project";
  naming = false;
  creating = false;
  proposed: string | undefined;
  readonly purpose = new InputBuffer();
  readonly name = new InputBuffer();

  constructor(
    private readonly port: BotsPort,
    private readonly hooks: BotCreateHooks,
    seed: BotCreateSeed = {},
  ) {
    if (seed.purpose !== undefined) this.purpose.load(seed.purpose);
    if (seed.slug !== undefined) {
      this.name.load(seed.slug);
      this.field = "scope";
    }
  }

  draft(): BotDraft {
    const purpose = this.purpose.value.trim();
    return {
      slug: this.name.value.trim(),
      scope: this.scope,
      ...(purpose !== "" && { purpose }),
    };
  }

  problem(): string | undefined {
    const slug = this.name.value.trim();
    if (slug === "") return undefined;
    const grammar = botSlugProblem(slug);
    if (grammar !== undefined) return grammar;
    return this.port.defined().some((bot) => bot.name === slug)
      ? `a bot named ${slug} already exists`
      : undefined;
  }

  rows(): BotCreateRow[] {
    return [
      this.textRow("purpose", "purpose", this.purpose, "what is this bot for? optional"),
      this.nameRow(),
      this.scopeRow(),
      { spans: [{ text: ` ${this.footer()}`, tone: "dim" }], selected: false },
    ];
  }

  rowCount(): number {
    return this.rows().length;
  }

  selectRow(row: number): void {
    const field = botCreateFields[row];
    if (field !== undefined) this.field = field;
  }

  paste(text: string): void {
    const buffer = this.activeBuffer();
    if (buffer === undefined) return;
    buffer.insert(text.replace(/\r?\n/g, " "));
    this.hooks.notify();
  }

  handleKey(chord: Chord, sequence: string | undefined): BotCreateKeyOutcome {
    if (this.creating) return "stay";
    if (chord.name === "escape") return this.back();
    if (isEnter(chord)) return this.advance();
    if (chord.name === "up" || chord.name === "down") {
      this.step(chord.name === "down" ? 1 : -1);
      return "stay";
    }
    if (this.field === "scope") this.handleScopeKey(chord);
    else this.editText(chord, sequence);
    this.hooks.notify();
    return "stay";
  }

  private advance(): BotCreateKeyOutcome {
    switch (this.field) {
      case "purpose":
        this.field = "name";
        if (this.name.isEmpty() && this.purpose.value.trim() !== "") void this.propose();
        return "stay";
      case "name":
        if (this.problem() !== undefined || this.name.isEmpty()) return "stay";
        this.field = "scope";
        return "stay";
      case "scope":
        if (this.problem() !== undefined || this.name.isEmpty()) {
          this.field = "name";
          return "stay";
        }
        void this.create();
        return "stay";
    }
  }

  private back(): BotCreateKeyOutcome {
    switch (this.field) {
      case "purpose":
        return "close";
      case "name":
        this.field = "purpose";
        return "stay";
      case "scope":
        this.field = "name";
        return "stay";
    }
  }

  private step(direction: 1 | -1): void {
    const at = botCreateFields.indexOf(this.field);
    const next = botCreateFields[at + direction];
    if (next !== undefined) this.field = next;
  }

  private handleScopeKey(chord: Chord): void {
    const toggles = chord.name === "left" || chord.name === "right" || chord.name === "tab";
    if (toggles || chord.name === "space")
      this.scope = this.scope === "project" ? "user" : "project";
  }

  private editText(chord: Chord, sequence: string | undefined): void {
    const buffer = this.activeBuffer();
    if (buffer === undefined) return;
    if (chord.name === "left") buffer.left();
    else if (chord.name === "right") buffer.right();
    else if (chord.name === "home") buffer.home();
    else if (chord.name === "end") buffer.end();
    else if (chord.name === "backspace") buffer.backspace();
    else if (isPrintable(chord, sequence)) buffer.insert(sequence);
    else return;
    if (this.field === "name") this.proposed = undefined;
  }

  private activeBuffer(): InputBuffer | undefined {
    if (this.field === "purpose") return this.purpose;
    if (this.field === "name") return this.name;
    return undefined;
  }

  private async propose(): Promise<void> {
    const suggest = this.port.suggestSlug;
    if (suggest === undefined) return;
    this.naming = true;
    this.hooks.notify();
    try {
      const slug = await suggest(this.purpose.value.trim());
      if (slug !== undefined && this.name.isEmpty() && botSlugProblem(slug) === undefined) {
        this.name.load(slug);
        this.proposed = slug;
      }
    } catch {
      this.proposed = undefined;
    } finally {
      this.naming = false;
      this.hooks.notify();
    }
  }

  private async create(): Promise<void> {
    this.creating = true;
    this.hooks.notify();
    try {
      this.hooks.created(await this.port.create(this.draft()));
    } catch (cause) {
      this.creating = false;
      this.hooks.notice(toError(cause).message);
      this.hooks.notify();
    }
  }

  private textRow(
    field: BotCreateField,
    label: string,
    buffer: InputBuffer,
    placeholder: string,
  ): BotCreateRow {
    const selected = this.field === field;
    const value = buffer.value;
    const shown = value === "" && !selected ? placeholder : value;
    return {
      selected,
      spans: [
        { text: ` ${label.padEnd(8)} › `, tone: "text" },
        { text: shown, tone: value === "" ? "dim" : "text" },
        ...(selected ? [{ text: "▌", tone: "accent" as const }] : []),
      ],
    };
  }

  private nameRow(): BotCreateRow {
    const row = this.textRow("name", "name", this.name, "a slug, or leave empty to be named");
    const problem = this.problem();
    const hint = this.naming
      ? { text: "  naming…", tone: "dim" as const }
      : problem !== undefined
        ? { text: `  ${problem}`, tone: "danger" as const }
        : this.proposed !== undefined && this.proposed === this.name.value
          ? { text: "  proposed · edit or enter", tone: "dim" as const }
          : undefined;
    return hint === undefined ? row : { ...row, spans: [...row.spans, hint] };
  }

  private scopeRow(): BotCreateRow {
    const selected = this.field === "scope";
    const mark = (scope: BotScope, text: string): ConnectSpan => ({
      text,
      tone: this.scope === scope ? (selected ? "accent" : "text") : "dim",
    });
    return {
      selected,
      spans: [
        { text: ` ${"scope".padEnd(8)} › `, tone: "text" },
        mark("project", "project"),
        { text: "  ", tone: "dim" },
        mark("user", "global"),
      ],
    };
  }

  private footer(): string {
    if (this.creating) return "creating…";
    switch (this.field) {
      case "purpose":
        return "enter next · esc closes";
      case "name":
        return this.name.isEmpty() && this.port.suggestSlug !== undefined
          ? "enter next · esc back · empty asks for a name"
          : "enter next · esc back";
      case "scope":
        return "enter creates · ← → switch · esc back";
    }
  }
}
