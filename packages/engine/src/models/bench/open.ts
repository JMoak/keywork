import { formatReference } from "../../inference/references.ts";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import type { Provider } from "../../provider.ts";
import type { FetchLike } from "../../providers/transport.ts";
import { type ProbeHttp, probeHttp, serverRootOf } from "../adapters/http.ts";
import { adapterFor } from "../adapters/registry.ts";
import type { ServerInventory } from "../adapters/types.ts";
import { type CapabilityCache, probeServer, withMeasuredDecode } from "../capabilities/index.ts";
import { hostedDecisionModel } from "../decide/detect.ts";
import type { Decider } from "../decide/types.ts";
import { localityOf } from "../policy/locality.ts";
import { bindForClass, declaredFingerprint } from "../policy/resolve.ts";
import type { BenchOpener, BenchOpening, BenchRefusal } from "./book.ts";
import type { BenchReport } from "./run.ts";

export interface LocalBenchOpenerOptions {
  cache: CapabilityCache;
  http?: ProbeHttp | undefined;
  fetchFn?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

export interface RegistryBenchOpenerOptions {
  registrations(): readonly ProviderRegistration[];
  provider(binding: InferenceBinding): Provider;
  decider?: ((binding: InferenceBinding) => Decider) | undefined;
}

export function localBenchOpener(options: LocalBenchOpenerOptions): BenchOpener {
  const http = options.http ?? probeHttp();
  const now = options.now ?? (() => new Date());
  return async ({ endpoint, model }) => {
    if (localityOf(endpoint) === "cloud") return undefined;
    const root = serverRootOf(endpoint);
    const probed = await probeServer(root, { http, cache: options.cache, now, models: [] });
    if (probed.status === "unreachable") return refused("unreachable", probed.detail);
    if (probed.status === "unrecognized") {
      return refused(
        "unrecognized",
        `${root} answers only /v1/models; the bench needs a server it recognizes by a native route`,
      );
    }
    const adapter = adapterFor(probed.fingerprint.kind);
    if (adapter === undefined || probed.inventory === null) {
      return refused("unrecognized", `no adapter drives ${probed.fingerprint.kind} yet`);
    }
    if (!serves(probed.inventory, model))
      return refused("missing", `${root} does not serve ${model}`);
    const replay = options.cache.record(root, model)?.reasoningReplay;
    return {
      ok: true,
      reference: formatReference({ provider: probed.fingerprint.kind, model }),
      fingerprint: probed.fingerprint,
      subject: {
        kind: "chat",
        provider: adapter.chat({
          name: probed.fingerprint.kind,
          root,
          model,
          fetchFn: options.fetchFn,
          replayReasoning: replay?.known === true && replay.value,
          fieldMemory: options.cache.fieldMemory(root, model),
        }),
      },
      measured: (report) => rememberDecode(options.cache, root, model, report, now()),
    };
  };
}

export function registryBenchOpener(options: RegistryBenchOpenerOptions): BenchOpener {
  return async ({ endpoint, model }) => {
    const registrations = options.registrations();
    const registration = registrations.find(
      (candidate) => serverRootOf(candidate.endpoint) === serverRootOf(endpoint),
    );
    if (registration === undefined) return undefined;
    const decider =
      hostedDecisionModel(endpoint, model) === undefined ? undefined : options.decider;
    const bound = bindForClass(
      { provider: registration.name, model },
      decider === undefined ? "strong" : "decide",
      registrations,
    );
    if (!bound.ok) return refused("missing", bound.failure.message);
    const { binding } = bound;
    try {
      return {
        ok: true,
        reference: formatReference(binding.reference),
        fingerprint: declaredFingerprint(binding),
        subject:
          decider === undefined
            ? { kind: "chat", provider: options.provider(binding) }
            : { kind: "decide", decider: decider(binding) },
      };
    } catch (cause) {
      return refused("failed", cause instanceof Error ? cause.message : String(cause));
    }
  };
}

function refused(refusal: BenchRefusal, error: string): BenchOpening {
  return { ok: false, refused: refusal, error };
}

function serves(inventory: ServerInventory, model: string): boolean {
  return [...inventory.installed, ...inventory.loaded].some(({ id }) => id === model);
}

function rememberDecode(
  cache: CapabilityCache,
  root: string,
  model: string,
  report: BenchReport,
  at: Date,
): void {
  const record = cache.record(root, model);
  if (report.kind !== "chat" || report.decodeTokensPerSecond === null || record === undefined) {
    return;
  }
  cache.store(withMeasuredDecode(record, report.decodeTokensPerSecond.mean, at.toISOString()));
}
