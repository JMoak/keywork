import { appBindings } from "./app-actions.ts";
import { Debounce, type DebounceTiming, realTiming } from "./debounce.ts";
import type { BindingSpec, Keymap } from "./keymap.ts";

export interface KeybindingSource {
  read(): Promise<Record<string, BindingSpec>>;
  watch?(changed: () => void): () => void;
}

export interface KeybindingSeams {
  keymap: Keymap;
  source: KeybindingSource;
  notice(text: string): void;
  aside?(text: string): void;
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
  const known = Object.entries(overrides).filter(([action]) => action in defaults);
  return { ...defaults, ...Object.fromEntries(known) };
}

export function unknownActions(
  defaults: Record<string, BindingSpec>,
  overrides: Record<string, BindingSpec>,
): string[] {
  return Object.keys(overrides).filter((action) => !(action in defaults));
}

export function skippedNotice(actions: readonly string[]): string {
  return `keybindings skipped actions this terminal doesn't have · ${actions.join(" · ")}`;
}

export async function applyKeybindings(seams: KeybindingSeams): Promise<boolean> {
  const defaults = seams.defaults ?? appBindings;
  try {
    const overrides = await seams.source.read();
    seams.keymap.rebind({ leader: leaderChord, bindings: resolveBindings(defaults, overrides) });
    announceSkipped(seams, unknownActions(defaults, overrides));
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

const announcedSkips = new WeakMap<KeybindingSeams, string>();

function announceSkipped(seams: KeybindingSeams, actions: readonly string[]): void {
  const heard = actions.join(",");
  if (announcedSkips.get(seams) === heard) return;
  announcedSkips.set(seams, heard);
  if (actions.length > 0) (seams.aside ?? seams.notice)(skippedNotice(actions));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
