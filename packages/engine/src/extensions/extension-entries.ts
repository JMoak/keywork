import type { CustomEntry, SessionEntry } from "../session/entries.ts";
import type { SessionStore } from "../session/store.ts";

export const extensionEntryType = "extension";

export interface ExtensionEntry {
  extension: string;
  type: string;
  data: unknown;
}

export function appendExtensionEntry(
  store: SessionStore,
  entry: ExtensionEntry,
): Promise<CustomEntry> {
  return store.appendCustom(extensionEntryType, entry);
}

export function extensionEntries(entries: readonly SessionEntry[]): ExtensionEntry[] {
  return entries.flatMap((entry) => {
    const parsed = extensionEntryOf(entry);
    return parsed === undefined ? [] : [parsed];
  });
}

export function extensionEntryOf(entry: SessionEntry): ExtensionEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== extensionEntryType) return undefined;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return undefined;
  const { extension, type } = data as Partial<ExtensionEntry>;
  if (typeof extension !== "string" || typeof type !== "string") return undefined;
  return { extension, type, data: (data as ExtensionEntry).data };
}
