import { probeToolCalls, withToolCallProbe } from "../adapters/behaviour.ts";
import { EndpointUnreachableError, type ProbeHttp } from "../adapters/http.ts";
import type { ServerAdapter, ServerInventory, ServerProbe } from "../adapters/types.ts";
import type { CapabilityCache } from "./cache.ts";
import { identifyServer, listedOnly } from "./fingerprint.ts";
import { blankRecord } from "./record.ts";
import type { CapabilityRecord, ServerFingerprint, ServerKind } from "./types.ts";

export interface CapabilityProbeOptions {
  http: ProbeHttp;
  cache: CapabilityCache;
  now?: (() => Date) | undefined;
  adapters?: readonly ServerAdapter[] | undefined;
  preferred?: readonly ServerKind[] | undefined;
  models?: readonly string[] | undefined;
  behaviour?: boolean | undefined;
  refresh?: boolean | undefined;
}

export type ServerProbeResult =
  | { status: "unreachable"; root: string; detail: string }
  | {
      status: "unrecognized";
      root: string;
      listedOnly: readonly string[];
      records: readonly CapabilityRecord[];
    }
  | {
      status: "recognized";
      root: string;
      fingerprint: ServerFingerprint;
      inventory: ServerInventory | null;
      records: readonly CapabilityRecord[];
    };

export async function probeServer(
  root: string,
  options: CapabilityProbeOptions,
): Promise<ServerProbeResult> {
  const probe: ServerProbe = { http: options.http, root, now: options.now ?? (() => new Date()) };
  try {
    const identified = await identifyServer(probe, {
      ...(options.adapters !== undefined && { adapters: options.adapters }),
      ...(options.preferred !== undefined && { preferred: options.preferred }),
    });
    if (identified === undefined) {
      const listed = await listedOnly(probe);
      return {
        status: "unrecognized",
        root,
        listedOnly: listed,
        records: await listedRecords(probe, listed, options),
      };
    }
    options.cache.remember(root, identified.fingerprint);
    if (identified.adapter === undefined) {
      return {
        status: "recognized",
        root,
        fingerprint: identified.fingerprint,
        inventory: null,
        records: [],
      };
    }
    return await describeServer(probe, identified.adapter, identified.fingerprint, options);
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError) {
      return { status: "unreachable", root, detail: cause.message };
    }
    throw cause;
  }
}

async function describeServer(
  probe: ServerProbe,
  adapter: ServerAdapter,
  fingerprint: ServerFingerprint,
  options: CapabilityProbeOptions,
): Promise<ServerProbeResult> {
  const inventory = await adapter.inventory(probe);
  const models = options.models ?? [
    ...new Set([
      ...inventory.installed.map((model) => model.id),
      ...inventory.loaded.map((model) => model.id),
    ]),
  ];
  const records: CapabilityRecord[] = [];
  for (const model of models) {
    const describe = () => adapter.describe(probe, model, fingerprint);
    records.push(await recordFor(probe, model, describe, options));
  }
  return { status: "recognized", root: probe.root, fingerprint, inventory, records };
}

async function listedRecords(
  probe: ServerProbe,
  listed: readonly string[],
  options: CapabilityProbeOptions,
): Promise<CapabilityRecord[]> {
  const models = options.models ?? listed;
  if (models.length === 0) return [];
  const fingerprint = listedFingerprint;
  options.cache.remember(probe.root, fingerprint);
  const records: CapabilityRecord[] = [];
  for (const model of models) {
    const describe = async () =>
      blankRecord(probe.root, model, fingerprint, probe.now().toISOString());
    records.push(await recordFor(probe, model, describe, options));
  }
  return records;
}

const listedFingerprint: ServerFingerprint = {
  id: "openai-compatible@unknown",
  kind: "openai-compatible",
  version: null,
  build: null,
  routes: ["/v1/models"],
};

async function recordFor(
  probe: ServerProbe,
  model: string,
  describe: () => Promise<CapabilityRecord>,
  options: CapabilityProbeOptions,
): Promise<CapabilityRecord> {
  const cached = options.refresh === true ? undefined : options.cache.record(probe.root, model);
  if (cached !== undefined && !wantsToolCallProbe(cached, options)) return cached;
  const described = cached ?? (await describe());
  const record = wantsToolCallProbe(described, options)
    ? withToolCallProbe(described, await probeToolCalls(probe, model))
    : described;
  options.cache.store(record);
  return options.cache.record(probe.root, model) ?? record;
}

function wantsToolCallProbe(record: CapabilityRecord, options: CapabilityProbeOptions): boolean {
  const generatesText = !record.modalities.known || record.modalities.value.output.includes("text");
  return options.behaviour === true && !record.tools.known && generatesText;
}
