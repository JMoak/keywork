import { MemoryInertError } from "@keywork/engine";
import type { MemoryPort } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export interface SourceForgettingPort {
  preview(source: string): Promise<SourceForgetPlanRecord | SourceForgetRefusalRecord>;
  apply(
    source: string,
    digest: string,
  ): Promise<SourceForgetReportRecord | SourceForgetRefusalRecord>;
}

export type ForgettingMemoryPort = MemoryPort & { forgetting?: SourceForgettingPort };

export interface SourceForgetCountsRecord {
  notes: number;
  anchors: number;
  edges: number;
  citations: number;
  entries: number;
  staged: number;
}

export interface SourceForgetPlanRecord {
  source: string;
  digest: string;
  counts: SourceForgetCountsRecord;
  notes: { name: string; path: string; firstLine: string }[];
  anchors: {
    note: string;
    at: string;
    sha?: string | undefined;
    checkpoint?: string | undefined;
  }[];
  edges: { subject: string; predicate: string; object: string }[];
  citations: { note: string; kind: "recall" | "citation"; timestamp: string; session?: string }[];
  entries: { id: string; date: string; time: string; text: string }[];
  staged: { id: string; kind: string; target: string; for: string; firstLine: string }[];
  kept: { note: string; reason: string }[];
}

export interface SourceForgetReportRecord {
  source: string;
  counts: SourceForgetCountsRecord;
  ledgerId?: string;
}

export interface SourceForgetRefusalRecord {
  refused: "invalid-source" | "stale";
  error: string;
}

const forgetBody: JsonSchema = {
  type: "object",
  required: ["entryId"],
  properties: {
    entryId: { type: "string", minLength: 1 },
    replacement: {
      type: "string",
      minLength: 1,
      description: "What the model sees instead. Absent, the entry leaves the model's context.",
    },
  },
  additionalProperties: false,
};

const sourceProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Where the memory came from: `session:<id>`, `creature:<slug>` (another creature's messages), `web:<origin>`, `workshop:<id>` (a workshop's output), `craft:<slug>` (a creature's whole craft section) or `craft:<slug>/<note>` (one craft note).",
};

const previewBody: JsonSchema = {
  type: "object",
  required: ["source"],
  properties: { source: sourceProperty },
  additionalProperties: false,
};

const applyBody: JsonSchema = {
  type: "object",
  required: ["source", "digest"],
  properties: {
    source: sourceProperty,
    digest: {
      type: "string",
      minLength: 1,
      description: "The `digest` of the dry run the keeper read; anything else is refused.",
    },
  },
  additionalProperties: false,
};

const unknownEntry = "no prompt or tool result on this session's path has that id";
const unservedForgetting = "this node does not serve forget by source yet";

export const forgetRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/forget",
    operationId: "forgetSessionEntry",
    summary:
      "Take one prompt or one tool result out of what the model sees, or rewrite it, while the transcript keeps the original: what the terminal's /forget does. `entryId` names a user prompt or a tool result message on the session's active path, with the ids `GET /sessions/{id}/entries` lists. Without `replacement` the model stops seeing it; with one, the model sees that text in its place. The edit is written to the session log as a `context_edit` entry, which becomes the leaf, and the session continues over the edited context. Needs an idle session. `session.state` and `session.tree` (`reason: \"leaf\"`, naming the edit) follow.",
    authenticated: true,
    requestBody: forgetBody,
    responses: {
      "200": "`{ edit }`: the `context_edit` entry written, with its `targetId` and `replacement`.",
      "400": "The body is not `{ entryId, replacement?: string }`.",
      "404": `No session has that id, or \`{ error: "${unknownEntry}" }\`.`,
      "409": "A turn is running; wait for it or abort it first.",
    },
  },
  {
    method: "POST",
    path: "/memory/forget/preview",
    operationId: "previewMemoryForget",
    summary:
      "The dry run of forgetting everything one source put in memory; it touches nothing. `plan` lists exactly what an apply would remove: the notes the source wrote (each with its first line), the checkpoint anchors they carry, every graph edge that touches them, the recall and citation lines naming them in the curation audit, for a session its daily entries, and the inbox items still staged from that source (`staged`: each with its `id`, `kind`, `target`, addressee `for` and first line); `counts` sums each list, `kept` names notes a session only shares with another session and why they stay, and `digest` fingerprints the whole plan for `POST /memory/forget/apply`. A `craft:<slug>` source reads that creature's own layer.",
    authenticated: true,
    requestBody: previewBody,
    responses: {
      "200":
        "`{ plan }`: `{ source, digest, counts, notes, anchors, edges, citations, entries, staged, kept }`.",
      "400": "The body is not `{ source }`, or the source is not one of the kinds named.",
      "403": "Memory is inert: the workspace is untrusted.",
      "501": `\`{ error: "${unservedForgetting}" }\`.`,
      "503": "Memory is not served by this host.",
    },
  },
  {
    method: "POST",
    path: "/memory/forget/apply",
    operationId: "applyMemoryForget",
    summary:
      "Forget a source for real, after its dry run: removes exactly the notes, daily entries, staged inbox items and audit citation lines `POST /memory/forget/preview` listed under `digest`, in one ledger entry that `POST /memory/ledger/{id}/revert` undoes byte for byte, and appends a `forgot <source> · <counts>` line to the curation audit. If the vault moved since the dry run (a note was added, edited or removed) nothing is touched and the answer is 409.",
    authenticated: true,
    requestBody: applyBody,
    responses: {
      "200":
        "`{ forgot }`: `{ source, counts, ledgerId? }`; no `ledgerId` when nothing was there to forget.",
      "400": "The body is not `{ source, digest }`, or the source is not one of the kinds named.",
      "403": "Memory is inert: the workspace is untrusted.",
      "409": "The dry run is stale; run it again and apply its new digest.",
      "501": `\`{ error: "${unservedForgetting}" }\`.`,
      "503": "Memory is not served by this host.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const forgetFamily = {
  routes: forgetRoutes,
  handlers: ({ host, log }) => ({
    forgetSessionEntry: async (request, { id }) => {
      const target = forgetTargetOf(await bodyOf(request));
      if (target === undefined) {
        return json(400, { error: "the body must be { entryId: string, replacement?: string }" });
      }
      const outcome = await host.forget(id ?? "", target.entryId, target.replacement);
      if (outcome === "missing") return missingSession();
      if (outcome === "busy") return json(409, { error: "a turn is running" });
      if (outcome === "unknown-entry") return json(404, { error: unknownEntry });
      log.record(id ?? "", "session.tree", { reason: "leaf", entryId: outcome.edit.id });
      return json(200, outcome);
    },
    previewMemoryForget: (request) =>
      withForgetting(host.memory, async (forgetting) => {
        const source = sourceOf(await bodyOf(request));
        if (source === undefined)
          return json(400, { error: "the body must be { source: string }" });
        return answered(await forgetting.preview(source), (plan) => ({ plan }));
      }),
    applyMemoryForget: (request) =>
      withForgetting(host.memory, async (forgetting) => {
        const target = appliedOf(await bodyOf(request));
        if (target === undefined) {
          return json(400, { error: "the body must be { source: string, digest: string }" });
        }
        return answered(await forgetting.apply(target.source, target.digest), (forgot) => ({
          forgot,
        }));
      }),
  }),
} satisfies RouteFamily<typeof forgetRoutes>;

export function forgettingOf(port: MemoryPort): SourceForgettingPort | undefined {
  return (port as ForgettingMemoryPort).forgetting;
}

async function withForgetting(
  port: MemoryPort | undefined,
  act: (forgetting: SourceForgettingPort) => Promise<Response>,
): Promise<Response> {
  if (port === undefined) return json(503, { error: "memory is not served by this host" });
  if (!port.trusted()) return json(403, { error: new MemoryInertError().message });
  const forgetting = forgettingOf(port);
  if (forgetting === undefined) return json(501, { error: unservedForgetting });
  try {
    return await act(forgetting);
  } catch (cause) {
    if (cause instanceof MemoryInertError) return json(403, { error: cause.message });
    throw cause;
  }
}

function answered<Value extends object>(
  outcome: Value | SourceForgetRefusalRecord,
  wrap: (value: Value) => object,
): Response {
  if (!isRefusal(outcome)) return json(200, wrap(outcome));
  return json(outcome.refused === "stale" ? 409 : 400, { error: outcome.error });
}

function isRefusal(outcome: object): outcome is SourceForgetRefusalRecord {
  return "refused" in outcome && typeof outcome.refused === "string";
}

function sourceOf(body: unknown): string | undefined {
  return nonBlank(fieldsOf<{ source: unknown }>(body)?.source);
}

function appliedOf(body: unknown): { source: string; digest: string } | undefined {
  const fields = fieldsOf<{ source: unknown; digest: unknown }>(body);
  const source = nonBlank(fields?.source);
  const digest = nonBlank(fields?.digest);
  return source === undefined || digest === undefined ? undefined : { source, digest };
}

function forgetTargetOf(body: unknown): { entryId: string; replacement?: string } | undefined {
  const fields = fieldsOf<{ entryId: unknown; replacement: unknown }>(body);
  const entryId = nonBlank(fields?.entryId);
  if (entryId === undefined) return undefined;
  if (fields?.replacement === undefined) return { entryId };
  const replacement = nonBlank(fields.replacement);
  return replacement === undefined ? undefined : { entryId, replacement };
}
