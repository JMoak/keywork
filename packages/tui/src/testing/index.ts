import { type Chord, parseChord } from "../keys.ts";

export interface PressTarget {
  handleKey(chord: Chord, sequence?: string): unknown;
}

export interface ModelPressTarget {
  handleKey(chord: Chord, width: number, sequence?: string): unknown;
}

export function press(target: PressTarget, ...specs: string[]): void {
  for (const spec of specs) target.handleKey(parseChord(spec), typedSequence(spec));
}

export function pressModel(target: ModelPressTarget, ...specs: string[]): void {
  for (const spec of specs)
    target.handleKey(parseChord(spec), modelPressWidth, typedSequence(spec));
}

const modelPressWidth = 5;

export function typedSequence(spec: string): string | undefined {
  if (spec === "space") return " ";
  return spec.length === 1 ? spec : undefined;
}

export async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
