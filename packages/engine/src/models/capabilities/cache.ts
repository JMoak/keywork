import type { FieldMemory } from "../adapters/types.ts";
import { withRejectedField } from "./record.ts";
import type { CapabilityRecord, RejectedField, ServerFingerprint, ServerKind } from "./types.ts";

export interface CapabilityCacheSnapshot {
  servers: Readonly<Record<string, ServerFingerprint>>;
  records: readonly CapabilityRecord[];
  rejections: Readonly<Record<string, readonly RejectedField[]>>;
}

export class CapabilityCache {
  private readonly servers = new Map<string, ServerFingerprint>();
  private readonly records = new Map<string, CapabilityRecord>();
  private readonly rejections = new Map<string, RejectedField[]>();

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
    this.records.set(keyOf(record.server.id, record.endpoint, record.model), record);
  }

  record(root: string, model: string): CapabilityRecord | undefined {
    const key = this.currentKey(root, model);
    const stored = key === undefined ? undefined : this.records.get(key);
    if (stored === undefined || key === undefined) return undefined;
    return (this.rejections.get(key) ?? []).reduce(withRejectedField, stored);
  }

  recordsFor(root: string): CapabilityRecord[] {
    const fingerprint = this.servers.get(root);
    return [...this.records.values()]
      .filter((record) => record.endpoint === root && record.server.id === fingerprint?.id)
      .map((record) => this.record(root, record.model) ?? record);
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

  private rejectedFields(root: string, model: string): readonly RejectedField[] {
    return this.rejections.get(this.rejectionKey(root, model)) ?? [];
  }

  private reject(root: string, model: string, field: string, status: number): void {
    const key = this.rejectionKey(root, model);
    const existing = this.rejections.get(key) ?? [];
    if (existing.some((entry) => entry.field === field)) return;
    this.rejections.set(key, [...existing, { field, status, learnedAt: this.now().toISOString() }]);
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
    for (const key of this.rejections.keys()) {
      if (key.includes(`|${root}|`) && !key.startsWith(`${current}|`)) this.rejections.delete(key);
    }
  }
}

function keyOf(fingerprintId: string, root: string, model: string): string {
  return `${fingerprintId}|${root}|${model}`;
}
