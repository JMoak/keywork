import { z } from "zod";
import { syncDir, VaultFiles } from "./vault-files.ts";

export interface LeaseRecord {
  host: string;
  acquired: string;
  expires: string;
}

export type LeaseClaim =
  | { kind: "held"; until: string }
  | { kind: "foreign"; host: string; until: string };

export interface SweepLeaseOptions {
  vaultRoot: string;
  host: string;
  now?: () => Date;
  ttlMs?: number;
}

export const leaseFile = `${syncDir}/lease.json`;
export const defaultLeaseTtlMs = 10 * 60_000;

export class SweepLease {
  readonly host: string;
  private readonly files: VaultFiles;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: SweepLeaseOptions) {
    this.host = options.host;
    this.files = new VaultFiles(options.vaultRoot);
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? defaultLeaseTtlMs;
  }

  async inspect(): Promise<LeaseRecord | undefined> {
    const raw = await this.files.read(leaseFile);
    if (raw === null) return undefined;
    const parsed = leaseSchema.safeParse(parseJson(raw));
    return parsed.success ? parsed.data : undefined;
  }

  async acquire(): Promise<LeaseClaim> {
    const current = await this.inspect();
    if (current !== undefined && current.host !== this.host && isFresh(current, this.now()))
      return { kind: "foreign", host: current.host, until: current.expires };
    const acquired = this.now();
    const expires = new Date(acquired.getTime() + this.ttlMs).toISOString();
    const record: LeaseRecord = { host: this.host, acquired: acquired.toISOString(), expires };
    await this.files.write(leaseFile, `${JSON.stringify(record)}\n`);
    return { kind: "held", until: expires };
  }

  async release(): Promise<void> {
    const current = await this.inspect();
    if (current?.host === this.host) await this.files.remove(leaseFile);
  }
}

export function isFresh(record: LeaseRecord, now: Date): boolean {
  return Date.parse(record.expires) > now.getTime();
}

const leaseSchema = z.object({
  host: z.string().min(1),
  acquired: z.string(),
  expires: z.string(),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
