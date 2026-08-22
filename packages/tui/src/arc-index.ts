import type { AppCore } from "./app-core.ts";
import { type ArcOrdinals, type ArcsPort, arcOrdinalsOf, suggestArcSlug } from "./arcs.ts";
import { ConversationPane } from "./conversation-pane.ts";
import type { PaneOrigin } from "./pane-kinds.ts";

export interface ArcIndex {
  readonly ordinalOf: ArcOrdinals;
  changed(): void;
  dispose(): void;
}

export function arcIndexOf(arcs: ArcsPort | undefined, onRefreshed: () => void): ArcIndex {
  let ordinals: ArcOrdinals = () => undefined;
  let disposed = false;
  const refresh = (): void => {
    if (arcs === undefined || disposed) return;
    void arcs
      .list()
      .then((listed) => {
        if (disposed) return;
        ordinals = arcOrdinalsOf(listed);
        onRefreshed();
      })
      .catch(() => {});
  };
  const unsubscribe = arcs?.subscribe?.(refresh);
  return {
    ordinalOf: (slug) => ordinals(slug),
    changed: refresh,
    dispose: () => {
      disposed = true;
      unsubscribe?.();
    },
  };
}

export async function seedArcFromOrigin(
  origin: PaneOrigin | undefined,
  core: AppCore,
  arcs: ArcsPort | undefined,
  bind: (slug: string | undefined) => Promise<void>,
): Promise<string | undefined> {
  if (origin === undefined) return undefined;
  const source =
    origin.sourcePaneId === undefined ? undefined : core.panes.get(origin.sourcePaneId);
  const sourcePane = source instanceof ConversationPane ? source : undefined;
  if (origin.arc === "inherit") {
    if (sourcePane?.arc === undefined) return undefined;
    await bind(sourcePane.arc);
    return undefined;
  }
  if (arcs === undefined) return "no arcs here · a trusted workspace is needed first";
  const taken = (await arcs.list()).map((arc) => arc.slug);
  const slug = suggestArcSlug(sourcePane?.titled(), taken);
  await arcs.create(slug);
  await bind(slug);
  return `arc → ${slug} · new`;
}
