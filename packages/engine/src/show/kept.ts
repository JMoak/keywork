import type { Setting } from "./setting.ts";

export interface KeptSettings {
  settings: readonly Setting[];
  spent: readonly Spend[];
}

export interface Spend {
  owner: string;
  at: string;
}

export interface SettingStorage {
  load(): KeptSettings;
  save(kept: KeptSettings): void;
}

export interface MemorySettingStorage extends SettingStorage {
  readonly kept: KeptSettings;
}

export const nothingKept: KeptSettings = { settings: [], spent: [] };

export function memorySettingStorage(initial: KeptSettings = nothingKept): MemorySettingStorage {
  let kept = initial;
  return {
    get kept() {
      return kept;
    },
    load: () => kept,
    save: (next) => {
      kept = next;
    },
  };
}
