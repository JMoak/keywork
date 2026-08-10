import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type TrustDecision = "trusted" | "untrusted" | "undecided";

export interface TrustStoreOptions {
  file?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

export class BlanketTrustError extends Error {
  constructor(path: string) {
    super(
      `refusing to record a trust decision for ${path} — it would cover every directory beneath it; grant session-only trust instead`,
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
  private readonly sessionDecisions = new Map<string, boolean>();

  constructor(options: TrustStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = canonicalTrustPath(options.home ?? homedir(), this.platform);
    this.file = options.file ?? join(homedir(), ".keywork", "trust.json");
  }

  resolve(cwd: string): TrustDecision {
    const persisted = this.read();
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
    const data = this.read();
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
    const data = this.read();
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
    return canonicalTrustPath(path, this.platform);
  }

  private read(): Record<string, boolean> {
    const raw = readFileIfExists(this.file);
    if (raw === undefined) return {};
    return parseTrustFile(this.file, raw);
  }

  private write(data: Record<string, boolean>): void {
    const sorted = Object.fromEntries(
      Object.keys(data)
        .sort()
        .map((key) => [key, data[key] === true]),
    );
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, `${JSON.stringify(sorted, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(this.file, 0o600);
  }
}

export function canonicalTrustPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

function readFileIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new TrustStoreError(file, `unreadable (${code ?? "unknown"})`);
  }
}

function parseTrustFile(file: string, raw: string): Record<string, boolean> {
  const parsed = parseJson(file, raw);
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

function parseJson(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new TrustStoreError(file, `not valid JSON: ${(cause as Error).message}`);
  }
}
