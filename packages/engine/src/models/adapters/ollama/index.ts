import type { Protocol } from "../../../inference/types.ts";
import { blankRecord, known, unknownCapability } from "../../capabilities/record.ts";
import type {
  CapabilityRecord,
  Evidence,
  Modalities,
  Probed,
  ServerFingerprint,
} from "../../capabilities/types.ts";
import { type HealthReading, healthReading } from "../../health/types.ts";
import { EndpointUnreachableError, joinUrl } from "../http.ts";
import { arrayAt, numberAt, objectAt, stringAt } from "../json.ts";
import { localChatProvider } from "../local-chat.ts";
import type {
  InstalledModel,
  LoadedModel,
  ServerAdapter,
  ServerInventory,
  ServerProbe,
} from "../types.ts";
import { fingerprintId, versionAtLeast } from "../version.ts";
import { ollamaDeltas, ollamaMessagesSince } from "./deltas.ts";
import { sameModel } from "./names.ts";

export { ollamaDeltas, ollamaLocalOnlyEnvironment } from "./deltas.ts";
export {
  type ContextCheck,
  type ContextVariant,
  contextVariant,
  createContextVariant,
  pinResident,
  verifyContext,
} from "./residency.ts";

export const ollamaAdapter: ServerAdapter = {
  deltas: ollamaDeltas,
  fingerprint: fingerprintOllama,
  inventory: ollamaInventory,
  describe: describeOllamaModel,
  health: ollamaHealth,
  chat: (options) => localChatProvider(ollamaDeltas, options),
};

async function fingerprintOllama(probe: ServerProbe): Promise<ServerFingerprint | undefined> {
  const reply = await probe.http.get(joinUrl(probe.root, "/api/version"));
  const version = reply.ok ? stringAt(reply.body, "version") : undefined;
  if (version === undefined) return undefined;
  return {
    id: fingerprintId("ollama", version),
    kind: "ollama",
    version,
    build: null,
    routes: ["/api/version"],
  };
}

async function ollamaInventory(probe: ServerProbe): Promise<ServerInventory> {
  const [tags, running] = await Promise.all([
    probe.http.get(joinUrl(probe.root, "/api/tags")),
    probe.http.get(joinUrl(probe.root, "/api/ps")),
  ]);
  return {
    installed: arrayAt(tags.body, "models").flatMap(installedModel),
    loaded: arrayAt(running.body, "models").flatMap(loadedModel),
  };
}

async function describeOllamaModel(
  probe: ServerProbe,
  model: string,
  fingerprint: ServerFingerprint,
): Promise<CapabilityRecord> {
  const [shown, running] = await Promise.all([
    probe.http.post(joinUrl(probe.root, "/api/show"), { model }),
    probe.http.get(joinUrl(probe.root, "/api/ps")),
  ]);
  const record = blankRecord(probe.root, model, fingerprint, probe.now().toISOString());
  const delta = (rule: string): Evidence => ({ source: "server-delta", rule });
  const withServerDeltas: CapabilityRecord = {
    ...record,
    protocols: known(protocolsFor(fingerprint.version), delta("MODEL-004, MODEL-005")),
    toolChoice: known(["auto"], delta("MODEL-002")),
    logprobs: known(false, delta("MODEL-002")),
    usageInStream: known(true, delta("MODEL-002")),
    prefixCacheReport: known(false, delta("MODEL-006")),
    strictSchemas: unknownCapability("MODEL-012: strict schemas stay off locally until probed"),
    responseFormat: unknownCapability(
      "Ollama /v1 json_schema support is untested (open question 2)",
    ),
  };
  if (!shown.ok) {
    return { ...withServerDeltas, tools: unknownCapability(`/api/show answered ${shown.status}`) };
  }
  return {
    ...withServerDeltas,
    ...fromShow(shown.body),
    contextAllocated: allocatedContext(running.body, model),
  };
}

const showRoute: Evidence = { source: "native-route", route: "/api/show" };

function fromShow(shown: unknown): Partial<CapabilityRecord> {
  const capabilities = arrayAt(shown, "capabilities").filter(
    (entry): entry is string => typeof entry === "string",
  );
  const has = (capability: string) => capabilities.includes(capability);
  return {
    tools: known(has("tools"), showRoute),
    imageInput: known(has("vision") ? "base64" : "none", showRoute),
    reasoning: known(has("thinking") ? "reasoning-effort" : "none", showRoute),
    decisionEndpoint: known(has("decision") ? "/v1/systemone" : null, showRoute),
    modalities: known(modalitiesOf(has), showRoute),
    contextTrained: trainedContext(shown),
    license: licenseOf(shown),
  };
}

function modalitiesOf(has: (capability: string) => boolean): Modalities {
  return {
    input: ["text", ...(has("vision") ? ["image"] : []), ...(has("audio") ? ["audio"] : [])],
    output: [
      ...(has("completion") ? ["text"] : []),
      ...(has("decision") ? ["decisions"] : []),
      ...(has("embedding") ? ["embedding"] : []),
    ],
  };
}

function trainedContext(shown: unknown): Probed<number> {
  const info = objectAt(shown, "model_info");
  const architecture = stringAt(info, "general.architecture");
  const length =
    architecture === undefined ? undefined : numberAt(info, `${architecture}.context_length`);
  return length === undefined
    ? unknownCapability("/api/show model_info carries no context_length")
    : known(length, showRoute);
}

function licenseOf(shown: unknown): Probed<string> {
  const declared = stringAt(objectAt(shown, "model_info"), "general.license");
  const text = stringAt(shown, "license")?.trim().split("\n")[0]?.trim();
  const license = declared ?? (text === "" ? undefined : text);
  return license === undefined
    ? unknownCapability("/api/show reports no license")
    : known(license, showRoute);
}

function allocatedContext(running: unknown, model: string): Probed<number> {
  const entry = arrayAt(running, "models").find((loaded) => sameModel(loaded, model));
  const length = numberAt(entry, "context_length");
  if (length === undefined) {
    return unknownCapability("not loaded; Ollama allocates context at load (MODEL-003)");
  }
  return known(length, { source: "native-route", route: "/api/ps" });
}

async function ollamaHealth(probe: ServerProbe, model?: string): Promise<HealthReading> {
  const checkedAt = probe.now().toISOString();
  try {
    const version = await probe.http.get(joinUrl(probe.root, "/api/version"));
    if (!version.ok)
      return healthReading("down", `/api/version answered ${version.status}`, checkedAt);
    if (model === undefined)
      return healthReading("up", `ollama ${stringAt(version.body, "version")}`, checkedAt);
    const running = await probe.http.get(joinUrl(probe.root, "/api/ps"));
    const resident = arrayAt(running.body, "models").some((loaded) => sameModel(loaded, model));
    return healthReading(
      "up",
      resident ? `${model} is loaded` : `${model} is not loaded; the first request loads it`,
      checkedAt,
      resident,
    );
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError)
      return healthReading("down", cause.message, checkedAt);
    throw cause;
  }
}

function protocolsFor(version: string | null): Protocol[] {
  return versionAtLeast(version, ollamaMessagesSince)
    ? ["chat-completions", "responses", "anthropic-messages"]
    : ["chat-completions"];
}

function installedModel(entry: unknown): InstalledModel[] {
  const id = stringAt(entry, "name") ?? stringAt(entry, "model");
  if (id === undefined) return [];
  return [
    {
      id,
      sizeBytes: numberAt(entry, "size") ?? null,
      family: stringAt(entry, "details", "family") ?? null,
      parameterSize: stringAt(entry, "details", "parameter_size") ?? null,
      quantization: stringAt(entry, "details", "quantization_level") ?? null,
    },
  ];
}

function loadedModel(entry: unknown): LoadedModel[] {
  const id = stringAt(entry, "name") ?? stringAt(entry, "model");
  if (id === undefined) return [];
  return [
    {
      id,
      state: "loaded",
      contextAllocated: numberAt(entry, "context_length") ?? null,
      memoryBytes: numberAt(entry, "size_vram") ?? numberAt(entry, "size") ?? null,
      expiresAt: stringAt(entry, "expires_at") ?? null,
    },
  ];
}
