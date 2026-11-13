import { createHash } from "node:crypto";
import { blankRecord, known, unknownCapability } from "../../capabilities/record.ts";
import type {
  CapabilityRecord,
  Evidence,
  Probed,
  ServerFingerprint,
} from "../../capabilities/types.ts";
import { type HealthReading, healthReading } from "../../health/types.ts";
import { EndpointUnreachableError, joinUrl } from "../http.ts";
import { arrayAt, isRecord, numberAt, objectAt, stringAt } from "../json.ts";
import { localChatProvider } from "../local-chat.ts";
import type {
  InstalledModel,
  LoadedModel,
  ServerAdapter,
  ServerDeltas,
  ServerInventory,
  ServerProbe,
} from "../types.ts";
import { fingerprintId } from "../version.ts";

const modelsRoute = "/api/v1/models";
const native: Evidence = { source: "native-route", route: modelsRoute };

export const lmStudioDeltas: ServerDeltas = {
  kind: "lm-studio",
  defaultPort: 1234,
  versionTested: "native v1 schema (fixture validated)",
  droppedChatFields: [],
  honoredToolChoice: null,
  imageInput: "base64",
  reasoningDeltaFields: ["reasoning", "reasoning_content"],
  saturationStatuses: [503],
  usageShape: "openai-chat",
  rules: { inventory: "https://lmstudio.ai/docs/developer/rest/list" },
};

export const lmStudioAdapter: ServerAdapter = {
  deltas: lmStudioDeltas,
  fingerprint,
  inventory,
  describe,
  health,
  chat: (options) => localChatProvider(lmStudioDeltas, options),
};

async function fingerprint(probe: ServerProbe): Promise<ServerFingerprint | undefined> {
  const reply = await probe.http.get(joinUrl(probe.root, modelsRoute));
  if (!reply.ok || !isRecord(reply.body) || !Array.isArray(reply.body.models)) return undefined;
  if (reply.body.models.length > 0 && !reply.body.models.some(validModel)) return undefined;
  const metadata = createHash("sha256").update(JSON.stringify(reply.body.models)).digest("hex");
  return {
    id: `${fingerprintId("lm-studio", null)}:${metadata}`,
    kind: "lm-studio",
    version: null,
    build: null,
    routes: [modelsRoute],
  };
}

async function inventory(probe: ServerProbe): Promise<ServerInventory> {
  const models = await modelsOf(probe);
  return { installed: models.flatMap(installed), loaded: models.flatMap(loaded) };
}

async function describe(
  probe: ServerProbe,
  model: string,
  server: ServerFingerprint,
): Promise<CapabilityRecord> {
  const base = blankRecord(probe.root, model, server, probe.now().toISOString());
  const found = (await modelsOf(probe)).find((candidate) => identifiers(candidate).includes(model));
  if (found === undefined) return base;
  const type = modelType(found);
  const capabilities = objectAt(found, "capabilities");
  const vision = capabilities.vision;
  const context = allocatedContext(found, model);
  return {
    ...base,
    protocols: type === "llm" ? known(["chat-completions"], native) : base.protocols,
    tools: unknownCapability(
      "LM Studio's training metadata does not verify tool calls. Run a tool-call probe before project work.",
    ),
    contextAllocated:
      context === undefined
        ? unknownCapability("Load this model and check its context setting in LM Studio.")
        : known(context, native),
    contextTrained: positiveCapability(
      numberAt(found, "max_context_length"),
      "Native model metadata does not report a context limit.",
    ),
    modalities: known(
      {
        input: ["text", ...(vision === true ? ["image"] : [])],
        output: type === "llm" ? ["text"] : type === "embedding" ? ["embedding"] : ["decisions"],
      },
      native,
    ),
    imageInput:
      typeof vision === "boolean" ? known(vision ? "base64" : "none", native) : base.imageInput,
  };
}

async function health(probe: ServerProbe, model?: string): Promise<HealthReading> {
  const at = probe.now().toISOString();
  try {
    const reply = await probe.http.get(joinUrl(probe.root, modelsRoute));
    if (!reply.ok || !isRecord(reply.body) || !Array.isArray(reply.body.models))
      return healthReading("down", `${modelsRoute} unavailable`, at);
    if (model === undefined) return healthReading("up", "LM Studio model inventory available", at);
    const found = reply.body.models.find((candidate) => identifiers(candidate).includes(model));
    if (found === undefined)
      return healthReading("down", `${model} is not in LM Studio's model inventory`, at, false);
    const resident = arrayAt(found, "loaded_instances").some(
      (instance) => stringAt(instance, "id") === model,
    );
    return healthReading(
      "up",
      resident
        ? `${model} is loaded`
        : `${model} is downloaded; load it in LM Studio to check its context`,
      at,
      resident,
    );
  } catch (cause) {
    if (cause instanceof EndpointUnreachableError) return healthReading("down", cause.message, at);
    throw cause;
  }
}

async function modelsOf(probe: ServerProbe): Promise<unknown[]> {
  const reply = await probe.http.get(joinUrl(probe.root, modelsRoute));
  return reply.ok ? arrayAt(reply.body, "models").filter(validModel) : [];
}

function modelType(model: unknown): "llm" | "embedding" | "decision" | undefined {
  const type = stringAt(model, "type");
  return type === "llm" || type === "embedding" || type === "decision" ? type : undefined;
}

function identifiers(model: unknown): string[] {
  return [
    ...new Set(
      [
        stringAt(model, "key"),
        ...arrayAt(model, "loaded_instances").map((instance) => stringAt(instance, "id")),
      ].filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

function installed(model: unknown): InstalledModel[] {
  const id = stringAt(model, "key");
  return id === undefined || id.trim() === ""
    ? []
    : [
        {
          id,
          sizeBytes: numberAt(model, "size_bytes") ?? null,
          family: stringAt(model, "architecture") ?? null,
          parameterSize: stringAt(model, "params_string") ?? null,
          quantization: stringAt(model, "quantization", "name") ?? null,
        },
      ];
}

function loaded(model: unknown): LoadedModel[] {
  const ids = new Set(
    arrayAt(model, "loaded_instances").flatMap((instance) => {
      const id = stringAt(instance, "id");
      return id === undefined || id.trim() === "" ? [] : [id];
    }),
  );
  return [...ids].map((id) => ({
    id,
    state: "loaded",
    contextAllocated: allocatedContext(model, id) ?? null,
    memoryBytes: null,
    expiresAt: null,
  }));
}

function allocatedContext(model: unknown, id: string): number | undefined {
  const instances = arrayAt(model, "loaded_instances").filter(
    (instance) => id === stringAt(instance, "id"),
  );
  const lengths = instances.map((instance) => numberAt(instance, "config", "context_length"));
  return lengths.length > 0 &&
    lengths.every((length): length is number => length !== undefined && length > 0)
    ? Math.min(...lengths)
    : undefined;
}

function positiveCapability(value: number | undefined, reason: string): Probed<number> {
  return value !== undefined && value > 0 ? known(value, native) : unknownCapability(reason);
}

function validModel(model: unknown): boolean {
  const id = stringAt(model, "key");
  return id !== undefined && id.trim() !== "" && modelType(model) !== undefined;
}
