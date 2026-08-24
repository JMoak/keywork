import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalPath } from "../canonical-path.ts";
import { type Disk, type JsonFileStore, jsonFileStore } from "../json-file-store.ts";

export type TrustDecision = "trusted" | "untrusted" | "undecided";

export interface TrustStoreOptions {
  file?: string;
  home?: string;
  platform?: NodeJS.Platform;
  disk?: Disk;
}

export class BlanketTrustError extends Error {
  constructor(path: string) {
    super(
      `refusing to record a trust decision for ${path}; it would cover every directory beneath it. Grant session-only trust instead`,
    );
    this.name = "BlanketTrustError";
  }
}

export class TrustStoreError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid trust store at ${file}: ${detail}`);
    this.name = "TrustStoreError";
  }
}

export class TrustStore {
  readonly file: string;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly store: JsonFileStore<Record<string, boolean>>;
  private readonly sessionDecisions = new Map<string, boolean>();

  constructor(options: TrustStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = canonicalPath(options.home ?? homedir(), this.platform);
    this.file = options.file ?? join(options.home ?? homedir(), ".keywork", "trust.json");
    this.store = jsonFileStore<Record<string, boolean>>({
      file: this.file,
      mode: "strict",
      private: true,
      disk: options.disk,
      error: (file, detail) => new TrustStoreError(file, detail),
      validate: (data) => parseTrustFile(this.file, data),
    });
  }

  resolve(cwd: string): TrustDecision {
    const persisted = this.persisted();
    const decision = this.nearestDecision(cwd, (path) =>
      this.sessionDecisions.has(path) ? this.sessionDecisions.get(path) : persisted[path],
    );
    if (decision === undefined) return "undecided";
    return decision ? "trusted" : "untrusted";
  }

  trust(cwd: string): void {
    this.persist(cwd, true);
  }

  untrust(cwd: string): void {
    this.persist(cwd, false);
  }

  forget(cwd: string): void {
    const path = this.canonical(cwd);
    this.sessionDecisions.delete(path);
    const data = this.persisted();
    if (path in data) {
      delete data[path];
      this.write(data);
    }
  }

  trustForSession(cwd: string): void {
    this.sessionDecisions.set(this.canonical(cwd), true);
  }

  untrustForSession(cwd: string): void {
    this.sessionDecisions.set(this.canonical(cwd), false);
  }

  private persist(cwd: string, decision: boolean): void {
    const path = this.canonical(cwd);
    if (!this.mayBlanket(path)) throw new BlanketTrustError(path);
    this.sessionDecisions.delete(path);
    const data = this.persisted();
    data[path] = decision;
    this.write(data);
  }

  private nearestDecision(
    cwd: string,
    lookup: (path: string) => boolean | undefined,
  ): boolean | undefined {
    const target = this.canonical(cwd);
    let current = target;
    while (true) {
      const decision = lookup(current);
      if (decision !== undefined && (current === target || this.mayBlanket(current))) {
        return decision;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  private mayBlanket(path: string): boolean {
    return path !== this.home && dirname(path) !== path;
  }

  private canonical(path: string): string {
    return canonicalPath(path, this.platform);
  }

  private persisted(): Record<string, boolean> {
    return this.store.read() ?? {};
  }

  private write(data: Record<string, boolean>): void {
    const sorted = Object.fromEntries(
      Object.keys(data)
        .sort()
        .map((key) => [key, data[key] === true]),
    );
    this.store.write(sorted);
  }
}

function parseTrustFile(file: string, parsed: unknown): Record<string, boolean> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrustStoreError(file, "expected an object of path to boolean");
  }
  const data: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "boolean") {
      throw new TrustStoreError(file, `value for ${JSON.stringify(key)} must be true or false`);
    }
    data[key] = value;
  }
  return data;
}
