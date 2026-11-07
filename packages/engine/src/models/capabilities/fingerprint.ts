import { EndpointUnreachableError, joinUrl } from "../adapters/http.ts";
import { arrayAt, isRecord, stringAt } from "../adapters/json.ts";
import { serverAdapters } from "../adapters/registry.ts";
import type { ServerAdapter, ServerProbe } from "../adapters/types.ts";
import { fingerprintId } from "../adapters/version.ts";
import type { ServerFingerprint, ServerKind } from "./types.ts";

export interface IdentifiedServer {
  fingerprint: ServerFingerprint;
  adapter: ServerAdapter | undefined;
}

export async function identifyServer(
  probe: ServerProbe,
  options: { adapters?: readonly ServerAdapter[]; preferred?: readonly ServerKind[] } = {},
): Promise<IdentifiedServer | undefined> {
  const adapters = ordered(options.adapters ?? serverAdapters, options.preferred ?? []);
  for (const adapter of adapters) {
    const fingerprint = await adapter.fingerprint(probe);
    if (fingerprint !== undefined) return { fingerprint, adapter };
  }
  for (const recognizer of recognizers) {
    const fingerprint = await recognize(probe, recognizer);
    if (fingerprint !== undefined) return { fingerprint, adapter: undefined };
  }
  return undefined;
}

export async function listedOnly(probe: ServerProbe): Promise<string[]> {
  try {
    const reply = await probe.http.get(joinUrl(probe.root, "/v1/models"));
    return arrayAt(reply.body, "data").flatMap((entry) => stringAt(entry, "id") ?? []);
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError) return [];
    throw cause;
  }
}

interface Recognizer {
  kind: ServerKind;
  route: string;
  accepts(body: unknown): boolean;
  version(body: unknown): string | null;
}

const recognizers: readonly Recognizer[] = [
  {
    kind: "lm-studio",
    route: "/api/v1/models",
    accepts: (body) =>
      ["models", "data"].some((key) =>
        arrayAt(body, key).some((entry) => stringAt(entry, "type") !== undefined),
      ),
    version: () => null,
  },
  {
    kind: "vllm",
    route: "/version",
    accepts: (body) => stringAt(body, "version") !== undefined,
    version: (body) => stringAt(body, "version") ?? null,
  },
  {
    kind: "sglang",
    route: "/server_info",
    accepts: (body) => isRecord(body) && stringAt(body, "version") !== undefined,
    version: (body) => stringAt(body, "version") ?? null,
  },
];

async function recognize(
  probe: ServerProbe,
  recognizer: Recognizer,
): Promise<ServerFingerprint | undefined> {
  const reply = await probe.http.get(joinUrl(probe.root, recognizer.route));
  if (!reply.ok || !recognizer.accepts(reply.body)) return undefined;
  const version = recognizer.version(reply.body);
  return {
    id: fingerprintId(recognizer.kind, version),
    kind: recognizer.kind,
    version,
    build: null,
    routes: [recognizer.route],
  };
}

function ordered(
  adapters: readonly ServerAdapter[],
  preferred: readonly ServerKind[],
): ServerAdapter[] {
  const rank = (adapter: ServerAdapter) => {
    const index = preferred.indexOf(adapter.deltas.kind);
    return index === -1 ? preferred.length : index;
  };
  return [...adapters].sort((left, right) => rank(left) - rank(right));
}
