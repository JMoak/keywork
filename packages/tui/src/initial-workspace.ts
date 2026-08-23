import type { SummonableKind } from "./pane-kinds.ts";

export type InitialPane =
  | { readonly kind: "conversation" }
  | { readonly kind: SummonableKind; readonly pinned?: true };

export const initialWorkspace: readonly InitialPane[] = [
  { kind: "conversation" },
  { kind: "session-tree" },
  { kind: "mcp" },
];
