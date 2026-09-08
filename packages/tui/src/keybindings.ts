import { appBindings } from "./app-actions.ts";
import { Debounce, type DebounceTiming, realTiming } from "./debounce.ts";
import { type BindingSpec, type Keymap, KeymapError } from "./keymap.ts";

export interface KeybindingSource {
  read(): Promise<Record<string, BindingSpec>>;
  watch?(changed: () => void): () => void;
}

export interface KeybindingSeams {
  keymap: Keymap;
  source: KeybindingSource;
  notice(text: string): void;
  defaults?: Record<string, BindingSpec>;
  timing?: DebounceTiming;
  quietMs?: number;
}

export const keybindingQuietMs = 150;
export const reloadedNotice = "keybindings reloaded";

export function resolveBindings(
  defaults: Record<string, BindingSpec>,
  overrides: Record<string, BindingSpec>,
): Record<string, BindingSpec> {
  for (const action of Object.keys(overrides)) {
    if (!(action in defaults)) throw new KeymapError(`no action named "${action}"`);
  }
  return { ...defaults, ...overrides };
}

export async function applyKeybindings(seams: KeybindingSeams): Promise<boolean> {
  try {
    seams.keymap.rebind({
      leader: leaderChord,
      bindings: resolveBindings(seams.defaults ?? appBindings, await seams.source.read()),
    });
    return true;
  } catch (cause) {
    seams.notice(`keybindings kept · ${messageOf(cause)}`);
    return false;
  }
}

export function watchKeybindings(seams: KeybindingSeams): () => void {
  const watch = seams.source.watch;
  if (watch === undefined) return () => {};
  const reload = (): void => {
    void applyKeybindings(seams).then((applied) => {
      if (applied) seams.notice(reloadedNotice);
    });
  };
  const settle = new Debounce(
    seams.quietMs ?? keybindingQuietMs,
    reload,
    seams.timing ?? realTiming,
  );
  const unwatch = watch(() => settle.touch());
  return () => {
    unwatch();
    settle.dispose();
  };
}

const leaderChord = "ctrl+k";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
