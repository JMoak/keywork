import type { AppCore } from "./app-core.ts";
import {
  type ArcOrdinals,
  type ArcSummary,
  type ArcsPort,
  arcOrdinalsOf,
  arcTag,
  suggestArcSlug,
} from "./arcs.ts";
import { ArcsPane } from "./arcs-pane.ts";
import type { CommandSpec } from "./commands.ts";
import { ConversationPane } from "./conversation-pane.ts";
import type { PaneOrigin } from "./pane-kinds.ts";
import { pluralize } from "./pluralize.ts";

export interface ArcIndex {
  readonly ordinalOf: ArcOrdinals;
  listed(): readonly ArcSummary[];
  changed(): void;
  dispose(): void;
}

export type ArcsListener = (listed: readonly ArcSummary[]) => void;

export function arcIndexOf(arcs: ArcsPort | undefined, onRefreshed: ArcsListener): ArcIndex {
  let ordinals: ArcOrdinals = () => undefined;
  let listed: readonly ArcSummary[] = [];
  let disposed = false;
  const refresh = (): void => {
    if (arcs === undefined || disposed) return;
    void arcs
      .list()
      .then((fresh) => {
        if (disposed) return;
        ordinals = arcOrdinalsOf(fresh);
        listed = fresh;
        onRefreshed(fresh);
      })
      .catch(() => {});
  };
  const unsubscribe = arcs?.subscribe?.(refresh);
  return {
    ordinalOf: (slug) => ordinals(slug),
    listed: () => listed,
    changed: refresh,
    dispose: () => {
      disposed = true;
      unsubscribe?.();
    },
  };
}

export function arcJumpCommands(core: AppCore, listed: readonly ArcSummary[]): CommandSpec[] {
  return listed
    .filter((arc) => arc.status === "active")
    .map((arc) => ({
      name: `arc-${arc.slug}`,
      label: arcTag(arc.slug),
      description: pluralize(arc.sessions, "session"),
      jump: true as const,
      run: () => jumpToArc(core, arc.slug),
    }));
}

export function firstArcIntroducer(introduce: (slug: string) => void): ArcsListener {
  let known: number | undefined;
  return (listed) => {
    const only = listed[0];
    if (known === 0 && listed.length === 1 && only !== undefined) introduce(only.slug);
    known = listed.length;
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

function jumpToArc(core: AppCore, slug: string): void {
  const arcPane = paneShowing(core, slug);
  if (arcPane !== undefined) {
    core.focusPane(arcPane);
    return;
  }
  core.summon("arcs");
  for (const pane of core.panes.values()) {
    if (pane instanceof ArcsPane) pane.model.drillInto({ kind: "arc", slug });
  }
}

function paneShowing(core: AppCore, slug: string): string | undefined {
  for (const [id, pane] of core.panes) {
    const descriptor = pane.describe?.();
    if (descriptor?.kind === "arc" && descriptor.arc === slug) return id;
  }
  return undefined;
}
