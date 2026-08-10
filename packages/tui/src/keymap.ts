import { type Chord, chordsEqual, formatChord, parseChord } from "./keys.ts";

export type Binding = { kind: "chord"; chord: Chord } | { kind: "leader"; key: string };

export type KeymapResult =
  | { type: "action"; action: string }
  | { type: "leader-pending" }
  | { type: "cancelled" }
  | { type: "pass" };

export type BindingSpec = string | readonly string[];

export interface KeymapOptions {
  leader?: string;
  timeoutMs?: number;
  bindings: Record<string, BindingSpec>;
}

export class Keymap {
  readonly timeoutMs: number;
  private readonly leader: Chord;
  private readonly bindings = new Map<string, Binding[]>();
  private pendingSince: number | undefined;
  private armedScope: ReadonlySet<string> | undefined;

  constructor(options: KeymapOptions) {
    this.leader = parseChord(options.leader ?? "ctrl+k");
    this.timeoutMs = options.timeoutMs ?? 2000;
    for (const [action, spec] of Object.entries(options.bindings)) {
      const specs = typeof spec === "string" ? [spec] : spec;
      const parsed = specs.filter((entry) => entry !== "none").map(parseBinding);
      if (parsed.length > 0) this.bindings.set(action, parsed);
    }
  }

  press(chord: Chord, nowMs: number): KeymapResult {
    if (this.isPending(nowMs)) {
      if (chordsEqual(chord, this.leader)) return this.disarm();
      return this.resolveLeaderKey(chord, nowMs);
    }
    if (chordsEqual(chord, this.leader)) {
      this.arm(nowMs);
      return { type: "leader-pending" };
    }
    const action = this.findByChord(chord);
    return action === undefined ? { type: "pass" } : { type: "action", action };
  }

  arm(nowMs: number, scope?: ReadonlySet<string>): void {
    this.pendingSince = nowMs;
    this.armedScope = scope;
  }

  armed(nowMs: number): boolean {
    return this.isPending(nowMs);
  }

  describe(action: string): string | undefined {
    const binding = this.bindings.get(action)?.[0];
    if (binding === undefined) return undefined;
    if (binding.kind === "chord") return formatChord(binding.chord);
    return `${formatChord(this.leader)} ${binding.key}`;
  }

  actions(): readonly string[] {
    return [...this.bindings.keys()];
  }

  private isPending(nowMs: number): boolean {
    if (this.pendingSince === undefined) return false;
    if (nowMs - this.pendingSince <= this.timeoutMs) return true;
    this.pendingSince = undefined;
    return false;
  }

  private resolveLeaderKey(chord: Chord, nowMs: number): KeymapResult {
    const scope = this.armedScope;
    this.disarm();
    if (chord.name === "escape") return { type: "cancelled" };
    const action = this.findByLeaderKey(chord);
    if (action !== undefined && (scope === undefined || scope.has(action))) {
      return { type: "action", action };
    }
    return scope === undefined ? { type: "cancelled" } : this.press(chord, nowMs);
  }

  private disarm(): KeymapResult {
    this.pendingSince = undefined;
    this.armedScope = undefined;
    return { type: "cancelled" };
  }

  private findByChord(chord: Chord): string | undefined {
    for (const [action, bindings] of this.bindings) {
      for (const binding of bindings) {
        if (binding.kind === "chord" && chordsEqual(binding.chord, chord)) return action;
      }
    }
    return undefined;
  }

  private findByLeaderKey(chord: Chord): string | undefined {
    const pressed = chord.shift ? `shift+${chord.name}` : chord.name;
    for (const [action, bindings] of this.bindings) {
      for (const binding of bindings) {
        if (binding.kind === "leader" && binding.key === pressed) return action;
      }
    }
    return undefined;
  }
}

function parseBinding(spec: string): Binding {
  const leaderMatch = spec.match(/^leader\s+(\S+)$/i);
  if (leaderMatch !== null)
    return { kind: "leader", key: (leaderMatch[1] as string).toLowerCase() };
  return { kind: "chord", chord: parseChord(spec) };
}
