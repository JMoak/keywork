import { jsonFileStore } from "@keywork/shared";
import { formatReference } from "../inference/references.ts";
import type { ModelReference } from "../inference/types.ts";
import type { ModelClass } from "../models/policy/types.ts";
import { type Cancel, type Clock, isoOf, systemClock } from "../routines/clock.ts";
import type { RepairEpisode } from "./types.ts";

export interface ModelSubject {
  reference: ModelReference;
  classes: ModelClass[];
  endpoint: string | null;
  refusal: string | null;
}

export type ModelWork = "conversation" | "chore";

export interface ModelNeed {
  creature: string;
  work: ModelWork;
}

export interface ModelFinding {
  reference: ModelReference;
  endpoint: string | null;
  at: string;
  answered: boolean;
  found: string;
}

export interface ModelEpisode extends RepairEpisode {
  creature: string;
  reference: ModelReference;
  endpoint: string;
}

export type ModelServerProbe = (endpoint: string, reference: ModelReference) => Promise<boolean>;

export interface ModelWatchOptions {
  probe: ModelServerProbe;
  file?: string | undefined;
  clock?: Clock | undefined;
  delaysMs?: readonly number[] | undefined;
  freshMs?: number | undefined;
}

export const modelRepairDelaysMs: readonly number[] = [30_000, 60_000, 120_000];

export class SilentServerError extends Error {
  constructor(
    readonly provider: string,
    readonly endpoint: string,
  ) {
    super(`${provider} does not answer at ${endpoint}; is its model server running?`);
    this.name = "SilentServerError";
  }
}

export class ModelWatch {
  private readonly findings = new Map<string, ModelFinding>();
  private readonly episodes = new Map<string, ModelEpisode>();
  private readonly timers = new Map<string, Cancel>();
  private readonly listeners = new Set<(creature: string | null) => void>();
  private readonly clock: Clock;
  private readonly delays: readonly number[];
  private readonly freshMs: number;
  private readonly kept:
    | { read(): ModelEpisode[]; write(episodes: ModelEpisode[]): void }
    | undefined;

  constructor(private readonly options: ModelWatchOptions) {
    this.clock = options.clock ?? systemClock;
    this.delays = options.delaysMs ?? modelRepairDelaysMs;
    this.freshMs = options.freshMs ?? 20_000;
    this.kept = options.file === undefined ? undefined : keptEpisodes(options.file);
    for (const episode of this.kept?.read() ?? []) {
      this.episodes.set(episodeKey(episode.creature, episode.reference), episode);
    }
  }

  heard(reference: ModelReference, endpoint: string | null): void {
    this.find(reference, endpoint, true, answersAt(endpoint));
    for (const episode of this.episodesFor(reference)) this.end(episode, "repaired");
  }

  silent(reference: ModelReference, endpoint: string, need: ModelNeed): void {
    this.find(reference, endpoint, false, silentAt(endpoint));
    if (need.work !== "conversation") return;
    const key = episodeKey(need.creature, reference);
    if (this.episodes.get(key)?.outcome === "repairing") return;
    if (this.episodes.get(key)?.outcome === "failed") return;
    const now = this.clock.now();
    const episode: ModelEpisode = {
      creature: need.creature,
      reference,
      endpoint,
      subject: formatReference(reference),
      startedAt: isoOf(now),
      tries: 0,
      bound: this.delays.length,
      nextAt: isoOf(now + (this.delays[0] ?? 0)),
      endedAt: null,
      outcome: "repairing",
    };
    this.episodes.set(key, episode);
    this.arm(key, episode);
    this.changed(need.creature);
  }

  async look(subjects: readonly ModelSubject[]): Promise<void> {
    const now = this.clock.now();
    await Promise.all(
      subjects.map(async ({ reference, endpoint }) => {
        if (endpoint === null) return;
        const seen = this.findingOf(reference);
        if (seen !== undefined && now - Date.parse(seen.at) < this.freshMs) return;
        await this.ask(reference, endpoint);
      }),
    );
  }

  findingOf(reference: ModelReference): ModelFinding | undefined {
    return this.findings.get(formatReference(reference));
  }

  episodesOf(creature: string): ModelEpisode[] {
    return [...this.episodes.values()].filter((episode) => episode.creature === creature);
  }

  async tryAgain(creature: string, reference: ModelReference): Promise<boolean> {
    const episode = this.episodes.get(episodeKey(creature, reference));
    const endpoint = episode?.endpoint ?? this.findingOf(reference)?.endpoint ?? null;
    if (endpoint === null) return false;
    return this.ask(reference, endpoint);
  }

  settle(creature: string, reference: ModelReference): void {
    const key = episodeKey(creature, reference);
    this.timers.get(key)?.();
    this.timers.delete(key);
    if (!this.episodes.delete(key)) return;
    this.persist();
    this.changed(creature);
  }

  subscribe(listener: (creature: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.listeners.clear();
  }

  private async ask(reference: ModelReference, endpoint: string): Promise<boolean> {
    const answered = await this.options.probe(endpoint, reference).catch(() => false);
    if (answered) this.heard(reference, endpoint);
    else this.find(reference, endpoint, false, silentAt(endpoint));
    return answered;
  }

  private arm(key: string, episode: ModelEpisode): void {
    if (episode.nextAt === null) return;
    this.timers.set(
      key,
      this.clock.at(Date.parse(episode.nextAt), () => void this.repairStep(key)),
    );
  }

  private async repairStep(key: string): Promise<void> {
    this.timers.delete(key);
    const episode = this.episodes.get(key);
    if (episode?.outcome !== "repairing") return;
    const tries = episode.tries + 1;
    this.episodes.set(key, { ...episode, tries });
    const answered = await this.ask(episode.reference, episode.endpoint);
    const current = this.episodes.get(key);
    if (answered || current?.outcome !== "repairing") return;
    const delay = this.delays[tries];
    if (delay === undefined) {
      this.end(current, "failed");
      return;
    }
    const next = { ...current, nextAt: isoOf(this.clock.now() + delay) };
    this.episodes.set(key, next);
    this.arm(key, next);
    this.changed(current.creature);
  }

  private end(episode: ModelEpisode, outcome: "repaired" | "failed"): void {
    const key = episodeKey(episode.creature, episode.reference);
    this.timers.get(key)?.();
    this.timers.delete(key);
    const ended = { ...episode, outcome, nextAt: null, endedAt: isoOf(this.clock.now()) };
    this.episodes.set(key, ended);
    this.persist();
    this.changed(episode.creature);
  }

  private episodesFor(reference: ModelReference): ModelEpisode[] {
    const named = formatReference(reference);
    return [...this.episodes.values()].filter(
      (episode) => formatReference(episode.reference) === named && episode.outcome !== "repaired",
    );
  }

  private find(
    reference: ModelReference,
    endpoint: string | null,
    answered: boolean,
    found: string,
  ): void {
    const key = formatReference(reference);
    const before = this.findings.get(key);
    const at = isoOf(this.clock.now());
    this.findings.set(key, { reference, endpoint, at, answered, found });
    if (before?.answered !== answered) this.changed(null);
  }

  private persist(): void {
    this.kept?.write([...this.episodes.values()].filter((episode) => episode.outcome === "failed"));
  }

  private changed(creature: string | null): void {
    for (const listener of [...this.listeners]) listener(creature);
  }
}

function answersAt(endpoint: string | null): string {
  return endpoint === null ? "answered its last turn" : `answers at ${endpoint}`;
}

function silentAt(endpoint: string | null): string {
  return endpoint === null ? "did not answer" : `does not answer at ${endpoint}`;
}

function episodeKey(creature: string, reference: ModelReference): string {
  return `${creature}\n${formatReference(reference)}`;
}

function keptEpisodes(file: string): {
  read(): ModelEpisode[];
  write(episodes: ModelEpisode[]): void;
} {
  const store = jsonFileStore<ModelEpisode[]>({ file, mode: "lenient", validate: episodesOf });
  return { read: () => store.read() ?? [], write: (episodes) => store.write(episodes) };
}

function episodesOf(data: unknown): ModelEpisode[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is ModelEpisode =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelEpisode).creature === "string" &&
      typeof (entry as ModelEpisode).endpoint === "string" &&
      typeof (entry as ModelEpisode).reference?.provider === "string" &&
      (entry as ModelEpisode).outcome === "failed",
  );
}
