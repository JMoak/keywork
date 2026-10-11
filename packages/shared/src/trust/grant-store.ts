import type { PermissionRule } from "../config/schema.ts";
import { type Disk, type JsonFileStore, jsonFileStore } from "../json-file-store.ts";
import { sameRule, withRules } from "./grants.ts";

export class GrantStoreError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid workspace permissions at ${file}: ${detail}`);
    this.name = "GrantStoreError";
  }
}

export interface GrantStoreOptions {
  file: string;
  disk?: Disk;
}

export class GrantStore {
  readonly file: string;
  private readonly store: JsonFileStore<GrantFile>;

  constructor(options: GrantStoreOptions) {
    this.file = options.file;
    this.store = jsonFileStore<GrantFile>({
      file: options.file,
      mode: "strict",
      private: true,
      disk: options.disk,
      error: (file, detail) => new GrantStoreError(file, detail),
      validate: (data) => parseGrantFile(options.file, data),
    });
  }

  rules(): readonly PermissionRule[] {
    return this.store.read()?.rules ?? [];
  }

  grant(rules: readonly PermissionRule[]): void {
    this.write(withRules(this.rules(), rules));
  }

  revoke(rule: PermissionRule): boolean {
    const held = this.rules();
    const kept = held.filter((candidate) => !sameRule(candidate, rule));
    if (kept.length === held.length) return false;
    this.write(kept);
    return true;
  }

  private write(rules: readonly PermissionRule[]): void {
    this.store.write({ rules: [...rules] });
  }
}

interface GrantFile {
  rules: PermissionRule[];
}

function parseGrantFile(file: string, data: unknown): GrantFile {
  const rules = (data as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) throw new GrantStoreError(file, "expected { rules: [...] }");
  return { rules: rules.map((rule, index) => parseGrant(file, rule, index)) };
}

function parseGrant(file: string, rule: unknown, index: number): PermissionRule {
  const { action, resource, effect } = (rule ?? {}) as Record<string, unknown>;
  const wellFormed =
    typeof rule === "object" &&
    Object.keys(rule as object).length === 3 &&
    nonEmptyString(action) &&
    nonEmptyString(resource) &&
    effect === "allow";
  if (!wellFormed) {
    throw new GrantStoreError(
      file,
      `rule ${index} must be exactly { action, resource, effect: "allow" }`,
    );
  }
  return { action, resource, effect };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
