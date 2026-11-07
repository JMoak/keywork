import { blankRecord, known, unknownCapability } from "../../capabilities/record.ts";
import type {
  CapabilityRecord,
  Evidence,
  Modalities,
  Probed,
  ReasoningDialect,
  ServerFingerprint,
} from "../../capabilities/types.ts";
import { type HealthReading, healthReading } from "../../health/types.ts";
import { EndpointUnreachableError, type HttpReply, joinUrl } from "../http.ts";
import { arrayAt, isRecord, numberAt, objectAt, stringAt } from "../json.ts";
import { localChatProvider } from "../local-chat.ts";
import type {
  InstalledModel,
  LoadedModel,
  LoadState,
  ServerAdapter,
  ServerInventory,
  ServerProbe,
} from "../types.ts";
import { fingerprintId } from "../version.ts";
import { llamaServerDeltas } from "./deltas.ts";

export { llamaServerDeltas } from "./deltas.ts";

export const llamaServerAdapter: ServerAdapter = {
  deltas: llamaServerDeltas,
  fingerprint: fingerprintLlamaServer,
  inventory: llamaServerInventory,
  describe: describeLlamaServerModel,
  health: llamaServerHealth,
  chat: (options) => localChatProvider(llamaServerDeltas, options),
};

async function fingerprintLlamaServer(probe: ServerProbe): Promise<ServerFingerprint | undefined> {
  const props = await probe.http.get(joinUrl(probe.root, "/props"));
  if (props.ok && isLlamaServerProps(props.body)) {
    const buildInfo = stringAt(props.body, "build_info") ?? null;
    const version = buildInfo?.split("-")[0] ?? null;
    return {
      id: fingerprintId("llama-server", version),
      kind: "llama-server",
      version,
      build: buildInfo,
      routes: ["/props"],
    };
  }
  const listing = await probe.http.get(joinUrl(probe.root, "/models"));
  if (!listing.ok || !isRouterListing(listing.body)) return undefined;
  return {
    id: fingerprintId("llama-server", null),
    kind: "llama-server",
    version: null,
    build: null,
    routes: ["/models"],
  };
}

async function llamaServerInventory(probe: ServerProbe): Promise<ServerInventory> {
  const listing = await probe.http.get(joinUrl(probe.root, "/models"));
  if (listing.ok && isRouterListing(listing.body)) {
    const entries = arrayAt(listing.body, "data");
    return {
      installed: entries.flatMap(installedEntry),
      loaded: entries.flatMap(routerLoadedEntry),
    };
  }
  const [served, props] = await Promise.all([
    probe.http.get(joinUrl(probe.root, "/v1/models")),
    probe.http.get(joinUrl(probe.root, "/props")),
  ]);
  const allocated = numberAt(props.body, "default_generation_settings", "n_ctx") ?? null;
  const entries = arrayAt(served.body, "data");
  return {
    installed: entries.flatMap(installedEntry),
    loaded: entries.flatMap((entry) => singleLoadedEntry(entry, allocated)),
  };
}

async function describeLlamaServerModel(
  probe: ServerProbe,
  model: string,
  fingerprint: ServerFingerprint,
): Promise<CapabilityRecord> {
  const [props, listing, served] = await Promise.all([
    probe.http.get(joinUrl(probe.root, `/props?model=${encodeURIComponent(model)}`)),
    probe.http.get(joinUrl(probe.root, "/models")),
    probe.http.get(joinUrl(probe.root, "/v1/models")),
  ]);
  const delta = (rule: string): Evidence => ({ source: "server-delta", rule });
  const record = blankRecord(probe.root, model, fingerprint, probe.now().toISOString());
  const modalities = modalitiesOf(listing, props, model);
  return {
    ...record,
    protocols: known(["chat-completions", "responses", "anthropic-messages"], delta("S14")),
    tools: unknownCapability("MODEL-007: tool calls are unverified until a behaviour probe"),
    toolChoice: unknownCapability("tool_choice modes are unverified on this build"),
    parallelTools: known(true, delta("S14 parallel_tool_calls")),
    responseFormat: known(["json_object", "json_schema"], delta("S14 grammar")),
    logprobs: known(true, delta("S14 n_probs")),
    usageInStream: known(true, delta("S14 usage")),
    prefixCacheReport: known(true, delta("S14 timings.cache_n")),
    ...templateCapabilities(props),
    ...modalityCapabilities(modalities),
    contextAllocated: allocatedContext(props),
    contextTrained: trainedContext(served, model),
    license: unknownCapability("llama-server reports no license"),
  };
}

async function llamaServerHealth(probe: ServerProbe, model?: string): Promise<HealthReading> {
  const checkedAt = probe.now().toISOString();
  try {
    const health = await probe.http.get(joinUrl(probe.root, "/health"));
    if (health.status === 503)
      return healthReading("loading", errorMessage(health), checkedAt, false);
    if (!health.ok) return healthReading("down", `/health answered ${health.status}`, checkedAt);
    const residency = model === undefined ? undefined : await routerResidency(probe, model);
    if (residency === "loading")
      return healthReading("loading", `${model} is loading`, checkedAt, false);
    const slots = await probe.http.get(joinUrl(probe.root, "/slots?fail_on_no_slot=1"));
    const resident = residency === undefined ? null : residency === "loaded";
    if (slots.status === 503)
      return healthReading("saturated", "every slot is busy", checkedAt, resident);
    return healthReading("up", "ready", checkedAt, resident);
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError)
      return healthReading("down", cause.message, checkedAt);
    throw cause;
  }
}

async function routerResidency(probe: ServerProbe, model: string): Promise<LoadState | undefined> {
  const listing = await probe.http.get(joinUrl(probe.root, "/models"));
  if (!listing.ok || !isRouterListing(listing.body)) return undefined;
  const entry = arrayAt(listing.body, "data").find((candidate) => idOf(candidate) === model);
  return entry === undefined ? "unloaded" : loadStateOf(entry);
}

const propsRoute: Evidence = { source: "native-route", route: "/props" };

function templateCapabilities(props: HttpReply): Partial<CapabilityRecord> {
  const template = props.ok ? stringAt(props.body, "chat_template") : undefined;
  if (template === undefined) return {};
  const dialect: ReasoningDialect | undefined = template.includes("enable_thinking")
    ? "chat-template-kwargs"
    : undefined;
  return {
    reasoningReplay: known(template.includes("reasoning_content"), propsRoute),
    ...(dialect !== undefined && { reasoning: known(dialect, propsRoute) }),
  };
}

function modalitiesOf(listing: HttpReply, props: HttpReply, model: string): Probed<Modalities> {
  const entry = isRouterListing(listing.body)
    ? arrayAt(listing.body, "data").find((candidate) => idOf(candidate) === model)
    : undefined;
  const architecture = objectAt(entry, "architecture");
  if (Array.isArray(architecture.input_modalities)) {
    return known(
      {
        input: stringsOf(architecture.input_modalities),
        output: stringsOf(architecture.output_modalities),
      },
      { source: "native-route", route: "/models" },
    );
  }
  const declared = objectAt(props.body, "modalities");
  if (!props.ok || Object.keys(declared).length === 0) {
    return unknownCapability("no modalities reported");
  }
  return known(
    {
      input: [
        "text",
        ...(declared.vision === true ? ["image"] : []),
        ...(declared.audio === true ? ["audio"] : []),
      ],
      output: ["text"],
    },
    propsRoute,
  );
}

function modalityCapabilities(modalities: Probed<Modalities>): Partial<CapabilityRecord> {
  if (!modalities.known) return { modalities };
  const { value, evidence } = modalities;
  return {
    modalities,
    imageInput: known(value.input.includes("image") ? "base64" : "none", evidence),
    decisionEndpoint: known(value.output.includes("decisions") ? "/v1/systemone" : null, evidence),
  };
}

function allocatedContext(props: HttpReply): Probed<number> {
  const allocated = numberAt(props.body, "default_generation_settings", "n_ctx");
  return props.ok && allocated !== undefined
    ? known(allocated, propsRoute)
    : unknownCapability("/props reported no slot context; the model may not be loaded");
}

function trainedContext(served: HttpReply, model: string): Probed<number> {
  const entries = arrayAt(served.body, "data");
  const entry = entries.find((candidate) => idOf(candidate) === model) ?? entries[0];
  const trained = numberAt(entry, "meta", "n_ctx_train");
  return trained === undefined
    ? unknownCapability("/v1/models carries no n_ctx_train")
    : known(trained, { source: "native-route", route: "/v1/models" });
}

function isLlamaServerProps(body: unknown): boolean {
  return isRecord(body) && isRecord(body.default_generation_settings);
}

function isRouterListing(body: unknown): boolean {
  const entries = arrayAt(body, "data");
  return (
    entries.length > 0 && entries.every((entry) => stringAt(entry, "status", "value") !== undefined)
  );
}

function installedEntry(entry: unknown): InstalledModel[] {
  const id = idOf(entry);
  if (id === undefined) return [];
  return [
    {
      id,
      sizeBytes: numberAt(entry, "meta", "size") ?? null,
      family: null,
      parameterSize: parameterSizeOf(numberAt(entry, "meta", "n_params")),
      quantization: null,
    },
  ];
}

function routerLoadedEntry(entry: unknown): LoadedModel[] {
  const id = idOf(entry);
  const state = loadStateOf(entry);
  if (id === undefined || state === "unloaded") return [];
  return [
    {
      id,
      state,
      contextAllocated: null,
      memoryBytes: null,
      expiresAt: null,
    },
  ];
}

function singleLoadedEntry(entry: unknown, allocated: number | null): LoadedModel[] {
  const id = idOf(entry);
  if (id === undefined) return [];
  return [{ id, state: "loaded", contextAllocated: allocated, memoryBytes: null, expiresAt: null }];
}

function loadStateOf(entry: unknown): LoadState {
  const value = stringAt(entry, "status", "value");
  if (value === "loaded" || value === "loading" || value === "sleeping") return value;
  return "unloaded";
}

function idOf(entry: unknown): string | undefined {
  return stringAt(entry, "id");
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parameterSizeOf(parameters: number | undefined): string | null {
  return parameters === undefined ? null : `${(parameters / 1e9).toFixed(1)}B`;
}

function errorMessage(reply: HttpReply): string {
  return stringAt(reply.body, "error", "message") ?? reply.text.slice(0, 200);
}
