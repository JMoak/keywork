import { join } from "node:path";
import { jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import type { CreaturesPort } from "./host.ts";

export interface CreatureHandoff {
  from: string;
  to: string;
  count: number;
  lastAt: string;
}

export type CreatureHandoffChangeKind = "counted" | "dropped";

export interface CreatureHandoffChange {
  change: CreatureHandoffChangeKind;
  handoff: CreatureHandoff;
}

export interface CreatureHandoffsPort {
  list(): CreatureHandoff[];
  subscribe(listener: (change: CreatureHandoffChange) => void): () => void;
}

export interface CreatureHandoffs extends CreatureHandoffsPort {
  handedOff(from: string, to: string): void;
  close(): void;
}

export interface CreatureHandoffsOptions {
  file: string;
  creatures: Pick<CreaturesPort, "subscribe">;
  notice(line: string): void;
  now?: (() => Date) | undefined;
}

export function handoffsFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "handoffs.json");
}

export function creatureHandoffs(options: CreatureHandoffsOptions): CreatureHandoffs {
  const now = options.now ?? (() => new Date());
  const kept = keptHandoffs(options.file, options.notice);
  const tally = new Map(kept.load().map((handoff) => [pairKeyOf(handoff), handoff]));
  const listeners = new Set<(change: CreatureHandoffChange) => void>();
  const announce = (change: CreatureHandoffChange): void => {
    for (const listener of [...listeners]) listener(change);
  };
  const dropAll = (creature: string): void => {
    const dropped = [...tally.values()].filter((handoff) => names(handoff, creature));
    if (dropped.length === 0) return;
    for (const handoff of dropped) tally.delete(pairKeyOf(handoff));
    kept.save(listOf(tally));
    for (const handoff of dropped) announce({ change: "dropped", handoff });
  };
  const unfollow = options.creatures.subscribe(({ slug, change }) => {
    if (change === "removed") dropAll(slug);
  });
  return {
    list: () => listOf(tally),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handedOff: (from, to) => {
      if (from === to) return;
      const count = (tally.get(pairKeyOf({ from, to }))?.count ?? 0) + 1;
      const handoff = { from, to, count, lastAt: now().toISOString() };
      tally.set(pairKeyOf(handoff), handoff);
      kept.save(listOf(tally));
      announce({ change: "counted", handoff });
    },
    close: unfollow,
  };
}

interface KeptHandoffs {
  load(): CreatureHandoff[];
  save(handoffs: CreatureHandoff[]): void;
}

const keptVersion = 1;

const keptHandoff = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  count: z.number().int().positive(),
  lastAt: z.string().refine((at) => !Number.isNaN(Date.parse(at)), "lastAt is a time"),
});

const keptFile = z.strictObject({
  version: z.literal(keptVersion),
  handoffs: z.array(keptHandoff),
});

function keptHandoffs(file: string, notice: (line: string) => void): KeptHandoffs {
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
        return store.read()?.handoffs ?? [];
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return [];
      }
    },
    save: (handoffs) => {
      try {
        store.write({ version: keptVersion, handoffs });
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
  throw new Error(`not a hand-off tally: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

function listOf(tally: ReadonlyMap<string, CreatureHandoff>): CreatureHandoff[] {
  return [...tally.values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function pairKeyOf({ from, to }: Pick<CreatureHandoff, "from" | "to">): string {
  return `${from} ${to}`;
}

function names(handoff: CreatureHandoff, creature: string): boolean {
  return handoff.from === creature || handoff.to === creature;
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
  return `the hand-offs counted at ${file} are unreadable (${oneLine(toError(cause).message)}); the tally starts from zero and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `hand-offs could not be saved to ${file} (${oneLine(toError(cause).message)}); they stay counted in memory and the next hand-off saves them again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
