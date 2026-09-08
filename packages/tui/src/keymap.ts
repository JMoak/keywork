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

export class KeymapError extends Error {
  override readonly name = "KeymapError";
}

export class Keymap {
  private table: BindingTable;
  private pendingSince: number | undefined;
  private armedScope: ReadonlySet<string> | undefined;

  constructor(options: KeymapOptions) {
    this.table = compileBindings(options);
  }

  get timeoutMs(): number {
    return this.table.timeoutMs;
  }

  rebind(options: KeymapOptions): void {
    this.table = compileBindings(options);
    this.disarm();
  }

  press(chord: Chord, nowMs: number, repeat = false): KeymapResult {
    if (this.isPending(nowMs)) {
      if (!chordsEqual(chord, this.table.leader)) return this.resolveLeaderKey(chord, nowMs);
      if (repeat) return { type: "leader-pending" };
      this.disarm();
      return cancelled;
    }
    if (chordsEqual(chord, this.table.leader)) {
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
    const binding = this.table.bindings.get(action)?.[0];
    if (binding === undefined) return undefined;
    return binding.kind === "chord"
      ? formatChord(binding.chord)
      : this.describeLeaderKey(binding.key);
  }

  actions(): readonly string[] {
    return [...this.table.bindings.keys()];
  }

  private describeLeaderKey(key: string): string {
    return `${formatChord(this.table.leader)} ${key}`;
  }

  private isPending(nowMs: number): boolean {
    if (this.pendingSince === undefined) return false;
    if (nowMs - this.pendingSince <= this.table.timeoutMs) return true;
    this.disarm();
    return false;
  }

  private resolveLeaderKey(chord: Chord, nowMs: number): KeymapResult {
    const scope = this.armedScope;
    this.disarm();
    if (chord.name === "escape") return cancelled;
    if (chord.ctrl || chord.meta) {
      return scope === undefined ? cancelled : this.press(chord, nowMs);
    }
    const action = this.findByLeaderKey(chord);
    if (action !== undefined && (scope === undefined || scope.has(action))) {
      return { type: "action", action };
    }
    return scope === undefined ? cancelled : this.press(chord, nowMs);
  }

  private disarm(): void {
    this.pendingSince = undefined;
    this.armedScope = undefined;
  }

  private findByChord(chord: Chord): string | undefined {
    for (const [action, bindings] of this.table.bindings) {
      for (const binding of bindings) {
        if (binding.kind === "chord" && chordsEqual(binding.chord, chord)) return action;
      }
    }
    return undefined;
  }

  private findByLeaderKey(chord: Chord): string | undefined {
    const pressed = leaderKeyOf(chord);
    for (const [action, bindings] of this.table.bindings) {
      for (const binding of bindings) {
        if (binding.kind === "leader" && binding.key === pressed) return action;
      }
    }
    return undefined;
  }
}

const cancelled: KeymapResult = { type: "cancelled" };

interface BindingTable {
  readonly leader: Chord;
  readonly timeoutMs: number;
  readonly bindings: ReadonlyMap<string, readonly Binding[]>;
}

function compileBindings(options: KeymapOptions): BindingTable {
  const leader = parseChord(options.leader ?? "ctrl+k");
  const bindings = new Map<string, Binding[]>();
  const claims = new Map<string, string>();
  for (const [action, spec] of Object.entries(options.bindings)) {
    const specs = typeof spec === "string" ? [spec] : spec;
    const parsed = specs.filter((entry) => entry !== "none").map(parseBinding);
    for (const binding of parsed) claim(claims, leader, binding, action);
    if (parsed.length > 0) bindings.set(action, parsed);
  }
  return { leader, timeoutMs: options.timeoutMs ?? 2000, bindings };
}

function claim(claims: Map<string, string>, leader: Chord, binding: Binding, action: string): void {
  const spec =
    binding.kind === "chord" ? formatChord(binding.chord) : `${formatChord(leader)} ${binding.key}`;
  if (binding.kind === "chord" && chordsEqual(binding.chord, leader)) {
    throw new KeymapError(`"${spec}" is the leader and cannot also run "${action}"`);
  }
  const holder = claims.get(spec);
  if (holder === action) throw new KeymapError(`"${spec}" is listed twice for "${action}"`);
  if (holder !== undefined) {
    throw new KeymapError(`"${spec}" is bound to both "${holder}" and "${action}"`);
  }
  claims.set(spec, action);
}

function parseBinding(spec: string): Binding {
  const leaderMatch = spec.match(/^leader\s+(\S+)$/i);
  if (leaderMatch === null) return { kind: "chord", chord: parseChord(spec) };
  const key = parseChord(leaderMatch[1] as string);
  if (key.ctrl || key.meta) {
    throw new KeymapError(
      `"${spec}" can never fire: leader keys take at most shift, since ctrl and alt end the leader`,
    );
  }
  return { kind: "leader", key: leaderKeyOf(key) };
}

function leaderKeyOf(chord: Chord): string {
  return chord.shift ? `shift+${chord.name}` : chord.name;
}
