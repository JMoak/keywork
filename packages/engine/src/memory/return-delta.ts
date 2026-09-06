import type { ArcRegistry } from "./arcs/registry.ts";
import type { AuditEntry } from "./audit.ts";
import type { BotRegistry } from "./bots/registry.ts";
import type { Note } from "./notes.ts";
import type { MemoryStore } from "./store.ts";

export interface BotIdentity {
  slug: string;
  sigil: string;
}

export interface ReturnDeltaInputs {
  since: string;
  workspaceNotes: readonly Note[];
  arc?: { slug: string; notes: readonly Note[] };
  bot?: BotIdentity & { notes: readonly Note[] };
  audit?: readonly AuditEntry[];
}

export interface GatherReturnDeltaOptions {
  since: string;
  workspace: MemoryStore;
  registry?: ArcRegistry;
  arc?: string;
  bots?: BotRegistry;
  bot?: BotIdentity;
}

export function returnDelta(inputs: ReturnDeltaInputs): string[] {
  const { since, workspaceNotes, arc, bot, audit } = inputs;
  return [
    ...additionsLine(arc?.notes ?? [], since, `new in #${arc?.slug}`),
    ...additionsLine(bot?.notes ?? [], since, `learned by ${bot?.sigil} ${bot?.slug}`),
    ...additionsLine(workspaceNotes, since, "new in the workspace"),
    ...supersededLine(workspaceNotes, since),
    ...deliveriesLine(audit ?? [], since),
  ];
}

export async function gatherReturnDelta(options: GatherReturnDeltaOptions): Promise<string[]> {
  const { since, workspace, registry, arc, bots, bot } = options;
  const arcNotes =
    registry === undefined || arc === undefined ? [] : await registry.arcStore(arc).listNotes();
  const botNotes =
    bots === undefined || bot === undefined ? [] : await bots.botStore(bot.slug).listNotes();
  return returnDelta({
    since,
    workspaceNotes: await workspace.listNotes(),
    ...(arc !== undefined && { arc: { slug: arc, notes: arcNotes } }),
    ...(bot !== undefined && { bot: { ...bot, notes: botNotes } }),
    audit: await workspace.readAudit(),
  });
}

const namesShown = 3;
const pairsShown = 2;

function additionsLine(notes: readonly Note[], since: string, label: string): string[] {
  const added = ordered(notes.filter((note) => (note.created ?? "") > since));
  if (added.length === 0) return [];
  return [`${added.length} ${label}: ${namedFew(added.map((note) => note.name))}`];
}

function supersededLine(notes: readonly Note[], since: string): string[] {
  const successors = new Map(notes.map((note) => [note.name, note]));
  const pairs = ordered(notes.filter((note) => note.supersededBy !== undefined)).flatMap((note) => {
    const successor =
      note.supersededBy === undefined ? undefined : successors.get(note.supersededBy);
    if (successor === undefined || (successor.created ?? "") <= since) return [];
    return [`[[${note.name}]] now [[${successor.name}]]`];
  });
  if (pairs.length === 0) return [];
  const shown = pairs.slice(0, pairsShown);
  const rest = pairs.length - shown.length;
  return [`${pairs.length} superseded: ${shown.join(" · ")}${rest > 0 ? ` +${rest} more` : ""}`];
}

function deliveriesLine(audit: readonly AuditEntry[], since: string): string[] {
  const slugs: string[] = [];
  for (const entry of audit) {
    if (entry.timestamp <= since) continue;
    const slug = /^arc (\S+) closed: delivered /.exec(entry.event)?.[1];
    if (slug !== undefined && !slugs.includes(slug)) slugs.push(slug);
  }
  if (slugs.length === 0) return [];
  return [`arcs delivered: ${slugs.sort().join(", ")}`];
}

function ordered(notes: readonly Note[]): Note[] {
  return [...notes].sort(
    (a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.name.localeCompare(b.name),
  );
}

function namedFew(names: readonly string[]): string {
  const shown = names.slice(0, namesShown).map((name) => `[[${name}]]`);
  const rest = names.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}
