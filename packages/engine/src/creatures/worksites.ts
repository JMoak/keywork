import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPath, jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import { isPromptEntry, type SessionEntry } from "../session/entries.ts";
import type { CreaturesPort } from "./host.ts";

export interface CreatureWorksite {
  creature: string;
  directory: string;
  root: string;
  project: string | null;
  conversations: number;
  since: string;
  latest: string;
  active: boolean;
}

export type CreatureWorksiteChangeKind = "changed" | "dropped";

export interface CreatureWorksiteChange {
  change: CreatureWorksiteChangeKind;
  worksite: CreatureWorksite;
}

export interface VisitorWorksites {
  worksites: CreatureWorksite[];
  working: number;
}

export interface CreatureWorksitesPort {
  list(): Promise<CreatureWorksite[]>;
  visiting(workspace: string): Promise<VisitorWorksites>;
  subscribe(listener: (change: CreatureWorksiteChange) => void): () => void;
}

export interface WorkingConversation {
  id: string;
  creature: string;
  root: string;
  visitor?: string | undefined;
}

export interface JournalledConversation extends WorkingConversation {
  entries: readonly SessionEntry[];
}

export interface WorksiteHistory {
  conversations: readonly JournalledConversation[];
}

export interface CreatureWorksites extends CreatureWorksitesPort {
  began(conversation: WorkingConversation): void;
  changedFile(conversation: WorkingConversation, path: string): void;
  rested(conversation: string): void;
  visited(project: string, worksites: readonly CreatureWorksite[]): void;
  projectQuiet(project: string): void;
  close(): void;
}

export interface CreatureWorksitesOptions {
  file: string;
  creatures: Pick<CreaturesPort, "subscribe">;
  history(): Promise<WorksiteHistory>;
  notice(line: string): void;
  now?: (() => Date) | undefined;
  isRepository?: ((directory: string) => boolean) | undefined;
}

export function worksitesFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "worksites.json");
}

export function changedFileOf(tool: string, args: unknown): string | undefined {
  if (!fileChangingTools.has(tool) || typeof args !== "object" || args === null) return undefined;
  const { path } = args as { path?: unknown };
  return typeof path === "string" && path !== "" ? path : undefined;
}

export function creatureWorksites(options: CreatureWorksitesOptions): CreatureWorksites {
  const clock = options.now ?? (() => new Date());
  const now = () => clock().toISOString();
  const kept = keptWorksites(options.file, options.notice);
  const tally = new Tally(options.isRepository ?? holdsRepository);
  const listeners = new Set<(change: CreatureWorksiteChange) => void>();
  let built = false;
  const announce = (change: CreatureWorksiteChangeKind, sites: Iterable<Site>): void => {
    const changed = [...sites];
    if (changed.length === 0) return;
    if (built) kept.save(tally.kept());
    for (const site of changed.filter(isOwn)) {
      const worksite = tally.rowOf(site);
      for (const listener of [...listeners]) listener({ change, worksite });
    }
  };
  const loaded = kept.load();
  if (loaded !== undefined) {
    tally.adopt(loaded);
    built = true;
  }
  const ready =
    loaded !== undefined
      ? Promise.resolve()
      : options.history().then(
          (history) => {
            tally.recall(history);
            built = true;
            kept.save(tally.kept());
          },
          (cause: unknown) => options.notice(unbuiltWords(cause)),
        );
  const unfollow = options.creatures.subscribe(({ slug, change }) => {
    if (change === "removed") announce("dropped", tally.drop(slug));
  });
  return {
    list: async () => {
      await ready;
      return tally.rows();
    },
    visiting: async (workspace) => {
      await ready;
      return tally.visiting(workspace);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    began: (conversation) => announce("changed", tally.began(conversation, now())),
    changedFile: (conversation, path) =>
      announce("changed", tally.changedFile(conversation, path, now())),
    rested: (conversation) => announce("changed", tally.rested(conversation, now())),
    visited: (project, worksites) => announce("changed", tally.visited(project, worksites)),
    projectQuiet: (project) => announce("changed", tally.projectQuiet(project)),
    close: unfollow,
  };
}

const fileChangingTools: ReadonlySet<string> = new Set(["write", "edit"]);

const stateFolder = ".keywork";

interface Site {
  visitor: string | null;
  creature: string;
  directory: string;
  root: string;
  project: string | null;
  since: string;
  latest: string;
  conversations: Set<string>;
  visits: Map<string, Visit>;
}

interface Visit {
  conversations: number;
  since: string;
  latest: string;
  active: boolean;
}

interface Place {
  directory: string;
  root: string;
  project: string | null;
}

interface Span {
  since: string;
  latest: string;
}

class Tally {
  private readonly sites = new Map<string, Site>();
  private readonly working = new Map<string, WorkingConversation>();
  private readonly repositories = new Map<string, boolean>();

  constructor(private readonly holdsRepository: (directory: string) => boolean) {}

  rows(): CreatureWorksite[] {
    return this.rowsWhere(isOwn);
  }

  visiting(workspace: string): VisitorWorksites {
    const working = [...this.working.values()].filter(
      (conversation) => conversation.visitor === workspace,
    );
    return {
      worksites: this.rowsWhere((site) => site.visitor === workspace),
      working: working.length,
    };
  }

  rowOf(site: Site): CreatureWorksite {
    const visits = [...site.visits.values()];
    return {
      creature: site.creature,
      directory: site.directory,
      root: site.root,
      project: site.project,
      conversations: visits.reduce(
        (sum, visit) => sum + visit.conversations,
        site.conversations.size,
      ),
      since: site.since,
      latest: site.latest,
      active: this.isWorking(site) || visits.some((visit) => visit.active),
    };
  }

  kept(): KeptWorksite[] {
    return [...this.sites.values()].map((site) => ({
      visitor: site.visitor,
      creature: site.creature,
      directory: site.directory,
      root: site.root,
      project: site.project,
      since: site.since,
      latest: site.latest,
      conversations: [...site.conversations],
      visits: [...site.visits].map(([project, { conversations, since, latest }]) => ({
        project,
        conversations,
        since,
        latest,
      })),
    }));
  }

  adopt(kept: readonly KeptWorksite[]): void {
    for (const { visits, conversations, ...row } of kept) {
      this.sites.set(siteKeyOf(row), {
        ...row,
        conversations: new Set(conversations),
        visits: new Map(
          visits.map(({ project, ...visit }) => [project, { ...visit, active: false }]),
        ),
      });
    }
  }

  recall(history: WorksiteHistory): void {
    for (const conversation of history.conversations) this.recallConversation(conversation);
  }

  began(conversation: WorkingConversation, at: string): Site[] {
    const touched = this.wake(conversation);
    if (!this.isRepository(conversation.root)) return touched;
    const home = this.count(conversation, this.repositoryPlace(conversation.root), spanAt(at));
    return unique([...touched, ...home]);
  }

  changedFile(conversation: WorkingConversation, path: string, at: string): Site[] {
    const touched = this.wake(conversation);
    const place = this.placeOf(conversation.root, path);
    if (place === undefined) return touched;
    return unique([...touched, ...this.count(conversation, place, spanAt(at))]);
  }

  rested(id: string, at: string): Site[] {
    const conversation = this.working.get(id);
    if (conversation === undefined) return [];
    this.working.delete(id);
    if (this.isRepository(conversation.root)) {
      const home = this.sites.get(siteKeyOf({ ...conversation, directory: conversation.root }));
      if (home !== undefined) home.latest = later(home.latest, at);
    }
    return this.sitesOf(id).filter((site) => !this.isActive(site));
  }

  visited(project: string, worksites: readonly CreatureWorksite[]): Site[] {
    return worksites.flatMap((row) => {
      const site = this.siteFor(row, { directory: row.directory, root: row.root, project }, row);
      const before = site.visits.get(project);
      site.visits.set(project, {
        conversations: row.conversations,
        since: row.since,
        latest: row.latest,
        active: row.active,
      });
      site.since = earlier(site.since, row.since);
      site.latest = later(site.latest, row.latest);
      const adopted = site.project === null;
      if (adopted) Object.assign(site, { root: row.root, project });
      const unchanged =
        before !== undefined &&
        before.conversations === row.conversations &&
        before.active === row.active;
      return unchanged && !adopted ? [] : [site];
    });
  }

  projectQuiet(project: string): Site[] {
    return [...this.sites.values()].filter((site) => {
      const visit = site.visits.get(project);
      if (visit?.active !== true) return false;
      visit.active = false;
      return true;
    });
  }

  drop(creature: string): Site[] {
    const dropped = [...this.sites.entries()].filter(
      ([, site]) => isOwn(site) && site.creature === creature,
    );
    for (const [key] of dropped) this.sites.delete(key);
    return dropped.map(([, site]) => site);
  }

  private rowsWhere(included: (site: Site) => boolean): CreatureWorksite[] {
    return [...this.sites.values()]
      .filter(included)
      .map((site) => this.rowOf(site))
      .sort(byCreatureThenSince);
  }

  private recallConversation(conversation: JournalledConversation): void {
    const span = this.isRepository(conversation.root)
      ? turnSpanOf(conversation.entries)
      : undefined;
    if (span !== undefined) this.count(conversation, this.repositoryPlace(conversation.root), span);
    for (const { path, at } of fileChangesIn(conversation.entries)) {
      const place = this.placeOf(conversation.root, path);
      if (place !== undefined) this.count(conversation, place, spanAt(at));
    }
  }

  private wake(conversation: WorkingConversation): Site[] {
    if (this.working.has(conversation.id)) return [];
    const sleeping = this.sitesOf(conversation.id).filter((site) => !this.isActive(site));
    this.working.set(conversation.id, conversation);
    return sleeping;
  }

  private count(conversation: WorkingConversation, place: Place, span: Span): Site[] {
    const site = this.siteFor(conversation, place, span);
    site.since = earlier(site.since, span.since);
    site.latest = later(site.latest, span.latest);
    if (site.conversations.has(conversation.id)) return [];
    site.conversations.add(conversation.id);
    return [site];
  }

  private siteFor(
    owner: Pick<WorkingConversation, "creature" | "visitor">,
    place: Place,
    span: Span,
  ): Site {
    const visitor = owner.visitor ?? null;
    const key = siteKeyOf({ visitor, creature: owner.creature, directory: place.directory });
    const found = this.sites.get(key);
    if (found !== undefined) return found;
    const opened: Site = {
      visitor,
      creature: owner.creature,
      ...place,
      since: span.since,
      latest: span.latest,
      conversations: new Set(),
      visits: new Map(),
    };
    this.sites.set(key, opened);
    return opened;
  }

  private placeOf(root: string, path: string): Place | undefined {
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (isOutside(inside)) return this.repositoryAbove(target);
    if (inside === "") return undefined;
    if (this.isRepository(root)) return this.repositoryPlace(root);
    const [child, ...rest] = inside.split(sep);
    if (child === undefined || rest.length === 0) return { directory: root, root, project: null };
    if (child === stateFolder) return undefined;
    return { directory: join(root, child), root, project: null };
  }

  private repositoryAbove(file: string): Place | undefined {
    for (let folder = dirname(file); ; folder = dirname(folder)) {
      if (this.isRepository(folder)) {
        const within = relative(folder, file).split(sep);
        return within.includes(stateFolder) ? undefined : this.repositoryPlace(folder);
      }
      if (dirname(folder) === folder) return undefined;
    }
  }

  private repositoryPlace(root: string): Place {
    return { directory: root, root, project: null };
  }

  private isRepository(directory: string): boolean {
    const key = canonicalPath(directory);
    const known = this.repositories.get(key);
    if (known !== undefined) return known;
    const holds = this.holdsRepository(directory);
    this.repositories.set(key, holds);
    return holds;
  }

  private sitesOf(id: string): Site[] {
    return [...this.sites.values()].filter((site) => site.conversations.has(id));
  }

  private isActive(site: Site): boolean {
    return this.isWorking(site) || [...site.visits.values()].some((visit) => visit.active);
  }

  private isWorking(site: Site): boolean {
    for (const id of site.conversations) if (this.working.has(id)) return true;
    return false;
  }
}

interface FileChange {
  path: string;
  at: string;
}

function fileChangesIn(entries: readonly SessionEntry[]): FileChange[] {
  const calls = new Map<string, string>();
  const changes: FileChange[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const part of entry.message.parts) {
      if (part.type === "tool-call") {
        const path = changedFileOf(part.name, part.arguments);
        if (path !== undefined) calls.set(part.callId, path);
      } else if (part.type === "tool-result" && !part.isError) {
        const path = calls.get(part.callId);
        if (path !== undefined && entry.timestamp !== "")
          changes.push({ path, at: entry.timestamp });
      }
    }
  }
  return changes;
}

function turnSpanOf(entries: readonly SessionEntry[]): Span | undefined {
  const since = entries.find((entry) => isPromptEntry(entry) && entry.timestamp !== "")?.timestamp;
  if (since === undefined) return undefined;
  const latest = entries.findLast((entry) => entry.timestamp !== "")?.timestamp ?? since;
  return { since, latest: later(since, latest) };
}

function spanAt(at: string): Span {
  return { since: at, latest: at };
}

function isOutside(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function isOwn(site: Pick<Site, "visitor">): boolean {
  return site.visitor === null;
}

function holdsRepository(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}

function siteKeyOf(
  site: Pick<Site, "creature" | "directory"> & { visitor?: string | null | undefined },
): string {
  return `${site.visitor ?? ""}\n${site.creature}\n${canonicalPath(site.directory)}`;
}

function byCreatureThenSince(left: CreatureWorksite, right: CreatureWorksite): number {
  return (
    left.creature.localeCompare(right.creature) ||
    left.since.localeCompare(right.since) ||
    left.directory.localeCompare(right.directory)
  );
}

function earlier(left: string, right: string): string {
  return right !== "" && right < left ? right : left;
}

function later(left: string, right: string): string {
  return right > left ? right : left;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

type KeptWorksite = z.infer<typeof keptWorksite>;

interface KeptWorksites {
  load(): KeptWorksite[] | undefined;
  save(worksites: KeptWorksite[]): void;
}

const keptVersion = 1;

const keptTime = z.string().refine((at) => !Number.isNaN(Date.parse(at)), "is a time");

const keptVisit = z.strictObject({
  project: z.string().min(1),
  conversations: z.number().int().positive(),
  since: keptTime,
  latest: keptTime,
});

const keptWorksite = z.strictObject({
  visitor: z.string().min(1).nullable(),
  creature: z.string().min(1),
  directory: z.string().min(1),
  root: z.string().min(1),
  project: z.string().min(1).nullable(),
  since: keptTime,
  latest: keptTime,
  conversations: z.array(z.string().min(1)),
  visits: z.array(keptVisit),
});

const keptFile = z.strictObject({
  version: z.literal(keptVersion),
  worksites: z.array(keptWorksite),
});

function keptWorksites(file: string, notice: (line: string) => void): KeptWorksites {
  const store = jsonFileStore({
    file,
    mode: "strict",
    private: true,
    validate: keptFileOf,
    error: (at, detail) => new Error(`${at} is ${detail}`),
  });
  let lastSaveFailed = false;
  return {
    load: () => {
      try {
        return store.read()?.worksites;
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return undefined;
      }
    },
    save: (worksites) => {
      try {
        store.write({ version: keptVersion, worksites });
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

function keptFileOf(data: unknown): z.infer<typeof keptFile> {
  const parsed = keptFile.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const at = issue?.path.join(".") ?? "";
  throw new Error(`not a worksite tally: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(file: string): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the worksites counted at ${file} are unreadable (${oneLine(toError(cause).message)}); they are counted again from the session journals and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `worksites could not be saved to ${file} (${oneLine(toError(cause).message)}); they stay counted in memory and the next change saves them again`;
}

function unbuiltWords(cause: unknown): string {
  return `the worksites of conversations from before this server could not be counted (${oneLine(toError(cause).message)}); new work is counted and the next start tries again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
