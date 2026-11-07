import { servedBy, unserved } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  nonBlank,
  type RouteContext,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export interface ModelsFilter {
  node?: string;
}

export interface ModelsProbeRequest {
  endpoint: string;
  model?: string;
  behaviour?: boolean;
  refresh?: boolean;
}

export interface ModelTarget {
  endpoint: string;
  model: string;
}

export interface ModelLicenseRequest extends ModelTarget {
  license: string;
}

export type ModelBenchRefusal = "busy" | "missing" | "unreachable" | "unrecognized" | "failed";

export type ModelBenchOutcome = { report: object } | { refused: ModelBenchRefusal; error: string };

export interface ModelsPort {
  list(filter: ModelsFilter): Promise<object>;
  probe(request: ModelsProbeRequest): Promise<object>;
  acknowledge?(request: ModelLicenseRequest): Promise<object>;
  bench?(target: ModelTarget): Promise<ModelBenchOutcome>;
  lastBench?(target: ModelTarget): Promise<object | null>;
}

export type ModelsPortOf = (context: RouteContext) => ModelsPort | undefined;

const endpointSchema: JsonSchema = { type: "string", format: "uri", pattern: "^https?://" };

const modelSchema: JsonSchema = { type: "string", minLength: 1 };

const probeBody: JsonSchema = {
  type: "object",
  required: ["endpoint"],
  properties: {
    endpoint: endpointSchema,
    model: modelSchema,
    behaviour: { type: "boolean" },
    refresh: { type: "boolean" },
  },
  additionalProperties: false,
};

const acknowledgementBody: JsonSchema = {
  type: "object",
  required: ["endpoint", "model", "license"],
  properties: {
    endpoint: endpointSchema,
    model: modelSchema,
    license: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const benchBody: JsonSchema = {
  type: "object",
  required: ["endpoint", "model"],
  properties: { endpoint: endpointSchema, model: modelSchema },
  additionalProperties: false,
};

export const modelRoutes = [
  {
    method: "GET",
    path: "/models",
    operationId: "listModels",
    summary:
      "Every model server this node knows, per node: servers the node manifests advertise and, for nodes without one, servers found by probing the known ports (11434 Ollama, 9931 llama-server, 8080, 1234, 8000, 30000) and fingerprinted by a native route, never by `/v1/models` alone. Each server carries its kind, fingerprint, source (`advertised` or `probed`) and health (`up | loading | saturated | down`); each model carries `installed`, `loaded`, allocated context, the classes it is eligible for (`strong | loop | decide | vision`) with what the others miss, its license and whether that license needs the keeper's acknowledgement, and its cost basis (`local_estimate` for local servers). A host that keeps license acknowledgements also gives each model `released` (the slate's release date, from which a model younger than 30 days reads as preview) and `acknowledgedAt` (when the keeper acknowledged its license, else null), fills a license the server does not report from the slate, and adds `market`: the cloud providers of the inference registry in the same columns (`kind` is the provider's name, `source: registry`, nothing installed or loaded, cost from the price table or null). A market row's health is `down` when the provider is disabled, has no credential, or refused its credential (401 or 403) on its latest turn, `up` once a turn it served answered, and `unverified` until then: listing a provider is not reaching it. A host with a default model also adds `inherits`: per class (`strong`, `loop`, `decide`, `vision`), what a creature or session whose policy says `inherit` gets, as `{ provider, model }` when the host's default model can serve the class, else `{ refused, detail }` with the IR-18 failure code (`missing-capability` for a default the class cannot use, `unconfigured` when the host has none). The class requirements of a local model are measurements of its mill; a cloud model is judged by what keywork.json or its provider's catalogue declares (context length, input modalities, tool calls), anything undeclared is unknown and never a shortfall, and decode speed is never asked of it, so a configured cloud default resolves unless a declared fact falls short; `detail` then names the model and the measurement. `decide` on a model with no decision endpoint or logprobs answers `{ provider, model, decider: builtin, detail }`: the built-in decider asks that model each question, and `detail` says so (since contract 1.20). `?node=` narrows to one node and leaves the market and the inherits out.",
    authenticated: true,
    responses: {
      "200":
        "`{ generatedAt, nodes: [{ node, servers: [{ kind, root, port, source, auth, fingerprint, version, health, models }] }], market?, inherits?: { strong, loop, decide, vision } }`.",
      "503": "This host serves no model inventory.",
    },
  },
  {
    method: "POST",
    path: "/models/probe",
    operationId: "probeModels",
    summary:
      "Probe one endpoint now: fingerprint it by native route, read its inventory, and return the capability record of each model (or of `model` alone), cached with the server fingerprint so a version change re-probes. `refresh` ignores the cache; `behaviour` also sends one small tool-call request to verify calls arrive in `tool_calls` before the model is admitted to tool classes. A server that answers only `/v1/models` comes back `unrecognized` with its listed ids and no capability marked.",
    authenticated: true,
    requestBody: probeBody,
    responses: {
      "200":
        "`{ root, status: recognized | unrecognized | unreachable, fingerprint, health, records, listedOnly, detail }`.",
      "400": "The body is not `{ endpoint: http(s) URL, model?, behaviour?, refresh? }`.",
      "503": "This host serves no model inventory.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const modelStewardshipRoutes = [
  {
    method: "POST",
    path: "/models/acknowledgements",
    operationId: "acknowledgeModelLicense",
    summary:
      "The keeper acknowledges a model's license (MODEL-049): `model` as `GET /models` lists it at `endpoint`, and the `license` it showed. The acknowledgement is kept in the node's state and answered as `{ model, license, acknowledgedAt }`; acknowledging the same model and license again answers the first acknowledgement. Until a license that needs acknowledgement is acknowledged, the model policy resolver refuses that model for every class with the IR-18 code `missing-capability` and the capability `license-acknowledgement`.",
    authenticated: true,
    requestBody: acknowledgementBody,
    responses: {
      "200": "`{ model, license, acknowledgedAt }`.",
      "400": "The body is not `{ endpoint: http(s) URL, model, license }`.",
      "503": "This host keeps no license acknowledgements.",
    },
  },
  {
    method: "POST",
    path: "/models/bench",
    operationId: "benchModel",
    summary:
      "Bench one model now, as `keywork models bench` does: at least three repeats of the replayed trace for a chat model (valid@1, tool-call accuracy, tokens and seconds per turn, decode tok/s, fallbacks) or of the labelled decisions for a hosted decision model (Brier, ECE, AUROC, threshold at target precision), every report carrying the server fingerprint. Answers when the bench finishes and keeps the report as the model's last; on a local server the measured decode speed is written to the model's capability record, which the `loop` class requires.",
    authenticated: true,
    requestBody: benchBody,
    responses: {
      "200":
        "The report, as `keywork models bench --json` prints it: `{ kind: chat | decide, reference, fingerprint, repeats, ... }`.",
      "400": "The body is not `{ endpoint: http(s) URL, model }`.",
      "404": "The endpoint does not serve that model.",
      "409": "That model is already on the bench.",
      "422": "The endpoint is not a server the bench can drive.",
      "500": "The bench failed; `error` says why.",
      "502": "The endpoint is unreachable.",
      "503": "This host runs no bench.",
    },
  },
  {
    method: "GET",
    path: "/models/bench",
    operationId: "readModelBench",
    summary:
      "The last bench report kept for one model, named by `?endpoint=&model=` as `POST /models/bench` took them: `{ report }`, where `report` is null until a bench there has finished.",
    authenticated: true,
    responses: {
      "200": "`{ report }`, null when the model has not been benched.",
      "400": "`endpoint` is not an http(s) URL or `model` is missing.",
      "503": "This host runs no bench.",
    },
  },
] as const satisfies readonly RouteSpec[];

const modelFamilyRoutes = [...modelRoutes, ...modelStewardshipRoutes] as const;

export function modelFamilyFor(portOf: ModelsPortOf): RouteFamily<typeof modelFamilyRoutes> {
  return {
    routes: modelFamilyRoutes,
    handlers: (context) => {
      const models = servedBy(() => portOf(context), "the model inventory");
      return {
        listModels: models(async (port, request) =>
          json(200, await port.list(modelsFilterOf(request))),
        ),
        probeModels: models(async (port, request) => {
          const probe = probeRequestOf(await bodyOf(request));
          if (probe === undefined) {
            return json(400, {
              error: "expected { endpoint: http(s) URL, model?, behaviour?, refresh? }",
            });
          }
          return json(200, await port.probe(probe));
        }),
        acknowledgeModelLicense: models(async (port, request) => {
          if (port.acknowledge === undefined) return unserved("license acknowledgement");
          const acknowledgement = licenseRequestOf(await bodyOf(request));
          if (acknowledgement === undefined) {
            return json(400, { error: "expected { endpoint: http(s) URL, model, license }" });
          }
          return json(200, await port.acknowledge(acknowledgement));
        }),
        benchModel: models(async (port, request) => {
          if (port.bench === undefined) return unserved("the model bench");
          const target = modelTargetOf(await bodyOf(request));
          if (target === undefined) {
            return json(400, { error: "expected { endpoint: http(s) URL, model }" });
          }
          const outcome = await port.bench(target);
          return "report" in outcome
            ? json(200, outcome.report)
            : json(benchRefusalStatus[outcome.refused], { error: outcome.error });
        }),
        readModelBench: models(async (port, request) => {
          if (port.lastBench === undefined) return unserved("the model bench");
          const target = modelTargetOf(queryFieldsOf(request));
          if (target === undefined) {
            return json(400, { error: "expected ?endpoint=<http(s) URL>&model=<id>" });
          }
          return json(200, { report: await port.lastBench(target) });
        }),
      };
    },
  };
}

export function modelsFilterOf(request: Request): ModelsFilter {
  const node = nonBlank(new URL(request.url).searchParams.get("node"));
  return node === undefined ? {} : { node };
}

export function probeRequestOf(body: unknown): ModelsProbeRequest | undefined {
  const fields = fieldsOf<{
    endpoint: unknown;
    model: unknown;
    behaviour: unknown;
    refresh: unknown;
  }>(body);
  const endpoint = httpUrl(fields?.endpoint);
  if (fields === undefined || endpoint === undefined) return undefined;
  const model = nonBlank(fields.model);
  if (fields.model !== undefined && model === undefined) return undefined;
  if (!optionalBoolean(fields.behaviour) || !optionalBoolean(fields.refresh)) return undefined;
  return {
    endpoint,
    ...(model !== undefined && { model }),
    ...(fields.behaviour === true && { behaviour: true }),
    ...(fields.refresh === true && { refresh: true }),
  };
}

export function modelTargetOf(body: unknown): ModelTarget | undefined {
  const fields = fieldsOf<{ endpoint: unknown; model: unknown }>(body);
  const endpoint = httpUrl(fields?.endpoint);
  const model = nonBlank(fields?.model);
  return endpoint === undefined || model === undefined ? undefined : { endpoint, model };
}

export function licenseRequestOf(body: unknown): ModelLicenseRequest | undefined {
  const target = modelTargetOf(body);
  const license = nonBlank(fieldsOf<{ license: unknown }>(body)?.license);
  return target === undefined || license === undefined ? undefined : { ...target, license };
}

const benchRefusalStatus: Readonly<Record<ModelBenchRefusal, number>> = {
  busy: 409,
  missing: 404,
  unrecognized: 422,
  failed: 500,
  unreachable: 502,
};

function queryFieldsOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

function httpUrl(value: unknown): string | undefined {
  const text = nonBlank(value);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}
