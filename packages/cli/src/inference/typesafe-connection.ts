import { join } from "node:path";
import type { FetchLike } from "@keywork/engine";
import { type KeyworkConfig, type MemoryDeciderName, memoryDeciderOf } from "@keywork/shared";
import { type SecretKeeping, saveCredential } from "../auth-store.ts";
import { typesafeRefusal } from "../memory-decider.ts";
import { updateUserConfig } from "../user-config.ts";
import { type BuiltInDecider, typesafeDecider } from "./builtins.ts";
import { recordObservation } from "./observations.ts";
import { type VerificationReport, verifyEndpoint } from "./verify.ts";

export type VerifiedKey = Extract<VerificationReport, { ok: true }>;

export interface DeciderConnection {
  readonly target: BuiltInDecider;
  readonly configFile: string;
  verify(key: string): Promise<VerificationReport>;
  save(key: string, verification: VerifiedKey): Promise<void>;
  selected(): MemoryDeciderName;
  select(): Promise<string>;
}

export interface DeciderConnectionDeps {
  userDir: string;
  config: () => KeyworkConfig;
  secrets?: (() => SecretKeeping | undefined) | undefined;
  changed: () => Promise<void>;
  fetchFn?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

export const typesafeTerms =
  "Jev sees the notes it is asked about; TypeSafe says it never trains on them and keeps them for a period it doesn't state, unless the account has enterprise zero retention.";

export function typesafeConnection(deps: DeciderConnectionDeps): DeciderConnection {
  const target = typesafeDecider;
  return {
    target,
    configFile: join(deps.userDir, "keywork.json"),
    verify: async (key) => refusalNamed(await verifyKey(target, key, deps)),
    save: async (key, verification) => {
      await saveCredential(target.name, { type: "api_key", key }, deps.userDir, deps.secrets?.());
      await recordObservation(
        target.name,
        {
          verifiedAt: verification.at,
          modelsReportedAt: verification.at,
          models: verification.models,
          lastFailure: undefined,
        },
        deps.userDir,
      );
      await deps.changed();
    },
    selected: () => memoryDeciderOf(deps.config()),
    select: async () => {
      const file = await updateUserConfig(
        (existing) => ({ ...existing, memory: { ...existing.memory, decider: "jev" } }),
        deps.userDir,
      );
      await deps.changed();
      return file;
    },
  };
}

function verifyKey(
  target: BuiltInDecider,
  key: string,
  deps: DeciderConnectionDeps,
): Promise<VerificationReport> {
  return verifyEndpoint({
    endpoint: target.endpoint,
    headers: { authorization: `Bearer ${key}` },
    ...(deps.fetchFn !== undefined && { fetchFn: deps.fetchFn }),
    ...(deps.now !== undefined && { now: deps.now }),
  });
}

function refusalNamed(report: VerificationReport): VerificationReport {
  if (report.ok || (report.status !== 401 && report.status !== 403)) return report;
  return { ...report, reason: typesafeRefusal };
}
