import type { FieldMemory } from "../adapters/types.ts";
import { withMeasuredDecode, withRejectedField } from "./record.ts";
import type {
  CapabilityRecord,
  Probed,
  RejectedField,
  ServerFingerprint,
  ServerKind,
} from "./types.ts";

export interface CapabilityCacheSnapshot {
  servers: Readonly<Record<string, ServerFingerprint>>;
  records: readonly CapabilityRecord[];
  rejections: Readonly<Record<string, readonly RejectedField[]>>;
}

export interface LearnedFacts {
  tools?: Probed<boolean> | undefined;
  decodeTokensPerSecond?: Probed<number> | undefined;
}

export interface CapabilityLearning {
  learned: Readonly<Record<string, LearnedFacts>>;
  rejections: Readonly<Record<string, readonly RejectedField[]>>;
}

export class CapabilityCache {
  private readonly servers = new Map<string, ServerFingerprint>();
  private readonly records = new Map<string, CapabilityRecord>();
  private readonly rejections = new Map<string, RejectedField[]>();
  private readonly learned = new Map<string, LearnedFacts>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  static restore(snapshot: CapabilityCacheSnapshot, now?: () => Date): CapabilityCache {
    const cache = new CapabilityCache(now);
    for (const [root, fingerprint] of Object.entries(snapshot.servers)) {
      cache.servers.set(root, fingerprint);
    }
    for (const record of snapshot.records) {
      cache.records.set(keyOf(record.server.id, record.endpoint, record.model), record);
    }
    for (const [key, fields] of Object.entries(snapshot.rejections)) {
      cache.rejections.set(key, [...fields]);
    }
    return cache;
  }

  remember(root: string, fingerprint: ServerFingerprint): void {
    const previous = this.servers.get(root);
    this.servers.set(root, fingerprint);
    if (previous !== undefined && previous.id !== fingerprint.id) this.forgetStale(root);
  }

  fingerprintOf(root: string): ServerFingerprint | undefined {
    return this.servers.get(root);
  }

  kindOf(root: string): ServerKind | undefined {
    return this.servers.get(root)?.kind;
  }

  store(record: CapabilityRecord): void {
    this.remember(record.endpoint, record.server);
    const key = keyOf(record.server.id, record.endpoint, record.model);
    this.records.set(key, record);
    this.learn(key, record);
  }

  record(root: string, model: string): CapabilityRecord | undefined {
    const key = this.currentKey(root, model);
    const stored = key === undefined ? undefined : this.records.get(key);
    if (stored === undefined || key === undefined) return undefined;
    const rejected = (this.rejections.get(key) ?? []).reduce(withRejectedField, stored);
    return withLearned(rejected, this.learned.get(key));
  }

  recordsFor(root: string): CapabilityRecord[] {
    const fingerprint = this.servers.get(root);
    return [...this.records.values()]
      .filter((record) => record.endpoint === root && record.server.id === fingerprint?.id)
      .map((record) => this.record(root, record.model) ?? record);
  }

  measuredDecode(root: string, model: string, tokensPerSecond: number): void {
    const record = this.record(root, model);
    if (record === undefined) return;
    const rounded = Math.round(tokensPerSecond * 10) / 10;
    this.store(withMeasuredDecode(record, rounded, this.now().toISOString()));
  }

  fieldMemory(root: string, model: string): FieldMemory {
    return {
      rejects: (field) => this.rejectedFields(root, model).some((entry) => entry.field === field),
      reject: (field, status) => this.reject(root, model, field, status),
    };
  }

  snapshot(): CapabilityCacheSnapshot {
    return {
      servers: Object.fromEntries(this.servers),
      records: [...this.records.values()],
      rejections: Object.fromEntries(this.rejections),
    };
  }

  learning(): CapabilityLearning {
    return {
      learned: Object.fromEntries(this.learned),
      rejections: Object.fromEntries(this.rejections),
    };
  }

  absorb(kept: CapabilityLearning): void {
    for (const [key, facts] of Object.entries(kept.learned)) {
      this.learned.set(key, { ...this.learned.get(key), ...facts });
    }
    for (const [key, fields] of Object.entries(kept.rejections)) {
      const known = this.rejections.get(key) ?? [];
      const fresh = fields.filter((field) => !known.some((entry) => entry.field === field.field));
      this.rejections.set(key, [...known, ...fresh]);
    }
  }

  onLearned(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private learn(key: string, record: CapabilityRecord): void {
    const facts: LearnedFacts = {
      ...this.learned.get(key),
      ...(isAsked(record.tools) && { tools: record.tools }),
      ...(isMeasured(record.decodeTokensPerSecond) && {
        decodeTokensPerSecond: record.decodeTokensPerSecond,
      }),
    };
    if (JSON.stringify(facts) === JSON.stringify(this.learned.get(key) ?? {})) return;
    this.learned.set(key, facts);
    this.changed();
  }

  private rejectedFields(root: string, model: string): readonly RejectedField[] {
    return this.rejections.get(this.rejectionKey(root, model)) ?? [];
  }

  private reject(root: string, model: string, field: string, status: number): void {
    const key = this.rejectionKey(root, model);
    const existing = this.rejections.get(key) ?? [];
    if (existing.some((entry) => entry.field === field)) return;
    this.rejections.set(key, [...existing, { field, status, learnedAt: this.now().toISOString() }]);
    this.changed();
  }

  private rejectionKey(root: string, model: string): string {
    return this.currentKey(root, model) ?? keyOf("unfingerprinted", root, model);
  }

  private currentKey(root: string, model: string): string | undefined {
    const fingerprint = this.servers.get(root);
    return fingerprint === undefined ? undefined : keyOf(fingerprint.id, root, model);
  }

  private forgetStale(root: string): void {
    const current = this.servers.get(root)?.id;
    for (const [key, record] of this.records) {
      if (record.endpoint === root && record.server.id !== current) this.records.delete(key);
    }
    const stale = (key: string) => key.includes(`|${root}|`) && !key.startsWith(`${current}|`);
    for (const key of [...this.rejections.keys()].filter(stale)) this.rejections.delete(key);
    for (const key of [...this.learned.keys()].filter(stale)) this.learned.delete(key);
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function keyOf(fingerprintId: string, root: string, model: string): string {
  return `${fingerprintId}|${root}|${model}`;
}

function isAsked(tools: Probed<boolean>): boolean {
  if (!tools.known) return false;
  const { evidence } = tools;
  return (
    evidence.source === "behaviour-probe" ||
    (evidence.source === "rejected-field" && evidence.field === "tools")
  );
}

function isMeasured(decode: Probed<number>): boolean {
  return decode.known && decode.evidence.source === "measured";
}

function withLearned(record: CapabilityRecord, facts: LearnedFacts | undefined): CapabilityRecord {
  if (facts === undefined) return record;
  const tools = !record.tools.known && facts.tools !== undefined ? facts.tools : undefined;
  const decode =
    !record.decodeTokensPerSecond.known && facts.decodeTokensPerSecond !== undefined
      ? facts.decodeTokensPerSecond
      : undefined;
  if (tools === undefined && decode === undefined) return record;
  return {
    ...record,
    ...(tools !== undefined && { tools }),
    ...(decode !== undefined && { decodeTokensPerSecond: decode }),
  };
}
