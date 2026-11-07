import type { Provenance } from "./notes.ts";
import type { MemorySource, MemorySourceKind } from "./sources.ts";
import { addresseeFor } from "./staging.ts";
import type { MemoryStore, WriteResult } from "./store.ts";

export type Admission = "admit" | "stage";

export const untrustedSourceKinds: readonly MemorySourceKind[] = ["web", "workshop", "creature"];

export interface SourcedNote {
  title: string;
  body: string;
  session?: string;
  self?: string;
}

export function admissionOf(source: MemorySource, self?: string): Admission {
  if (source.kind === "creature" && source.id === self) return "admit";
  return untrustedSourceKinds.includes(source.kind) ? "stage" : "admit";
}

export function provenanceFor(source: MemorySource, self?: string): Provenance {
  return admissionOf(source, self) === "stage" ? "untrusted" : "agent";
}

export function rememberFrom(
  store: Pick<MemoryStore, "writeNote">,
  source: MemorySource,
  note: SourcedNote,
): Promise<WriteResult> {
  return store.writeNote({
    title: note.title,
    body: note.body,
    provenance: provenanceFor(source, note.self),
    origin: source,
    addressee: addresseeFor(note.self),
    ...(note.session !== undefined && { session: note.session }),
  });
}
