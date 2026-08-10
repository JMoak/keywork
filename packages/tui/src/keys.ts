export interface Chord {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export function parseChord(spec: string): Chord {
  const parts = spec.toLowerCase().split("+");
  const name = parts.at(-1);
  if (name === undefined || name === "") throw new Error(`Invalid chord: "${spec}"`);
  const modifiers = new Set(parts.slice(0, -1));
  const known = new Set(["ctrl", "shift", "alt", "meta"]);
  for (const modifier of modifiers) {
    if (!known.has(modifier)) throw new Error(`Unknown modifier "${modifier}" in chord "${spec}"`);
  }
  return {
    name,
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("alt") || modifiers.has("meta"),
  };
}

export function formatChord(chord: Chord): string {
  const parts = [
    ...(chord.ctrl ? ["ctrl"] : []),
    ...(chord.shift ? ["shift"] : []),
    ...(chord.meta ? ["alt"] : []),
    chord.name,
  ];
  return parts.join("+");
}

export function chordsEqual(left: Chord, right: Chord): boolean {
  return (
    left.name === right.name &&
    left.ctrl === right.ctrl &&
    left.shift === right.shift &&
    left.meta === right.meta
  );
}

const modifierOnlyKeys = new Set([
  "ctrl",
  "shift",
  "alt",
  "meta",
  "super",
  "hyper",
  "capslock",
  "numlock",
]);

export function chordOf(key: {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  eventType?: string;
}): Chord | undefined {
  if (key.eventType === "release") return undefined;
  if (key.name === undefined || key.name === "") return undefined;
  const name = key.name.toLowerCase();
  if (modifierOnlyKeys.has(name)) return undefined;
  return {
    name,
    ctrl: key.ctrl === true,
    shift: key.shift === true,
    meta: key.meta === true || key.option === true,
  };
}
