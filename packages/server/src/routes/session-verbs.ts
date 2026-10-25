import {
  type AgentContext,
  compactionDue,
  contextFullness,
  costBasis,
  type EffortLevel,
  effortLevels,
  flushDue,
  isEffortLevel,
} from "@keywork/engine";
import { type PresetName, presetOrder } from "@keywork/shared";
import type { CostReport, ExportScope, Refusal } from "../host.ts";
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

export interface ContextAnswer extends AgentContext {
  fullness: number;
  flushDue: boolean;
  compactionDue: boolean;
}

export interface CostAnswer extends CostReport {
  basis: string;
}

const modelBody: JsonSchema = {
  type: "object",
  required: ["reference"],
  properties: {
    reference: {
      type: "string",
      minLength: 1,
      description: "`provider/model`, or a bare model name when only one provider offers it.",
    },
  },
  additionalProperties: false,
};

const thinkingBody: JsonSchema = {
  type: "object",
  required: ["on"],
  properties: { on: { type: "boolean" } },
  additionalProperties: false,
};

const effortBody: JsonSchema = {
  type: "object",
  required: ["level"],
  properties: { level: { type: ["string", "null"], enum: [...effortLevels, null] } },
  additionalProperties: false,
};

const compactBody: JsonSchema = {
  type: "object",
  properties: { focus: { type: "string" } },
  additionalProperties: false,
};

const restoreBody: JsonSchema = {
  type: "object",
  required: ["turn"],
  properties: {
    turn: {
      type: "integer",
      minimum: 1,
      description:
        "The turn to restore to just before: its prompt's 1-based place among the prompts on the session's active path.",
    },
  },
  additionalProperties: false,
};

const exportBody: JsonSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["path", "tree"], default: "path" },
    out: { type: "string", description: "A file or directory inside the workspace scope." },
  },
  additionalProperties: false,
};

const renameBody: JsonSchema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const presetBody: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", enum: [...presetOrder] },
    confirmed: { type: "boolean", const: true },
  },
  additionalProperties: false,
};

const busyResponse = "A turn is running; wait for it or abort it first.";
const missingResponse = "No session has that id.";

export const sessionVerbRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/model",
    operationId: "setSessionModel",
    summary:
      "Switch the model this session talks to from its next prompt on. The reference is resolved against the configured providers, the session's agent is rebuilt over the same history, and the choice is written to the session so a later open keeps it. A `session.state` envelope follows.",
    authenticated: true,
    requestBody: modelBody,
    responses: {
      "200": "`{ model: { provider, model }, notice }`.",
      "400":
        "The body is not `{ reference }`, or the reference did not resolve: `code` carries the resolution failure (`unknown-model`, `unknown-provider`, `ambiguous`, `unavailable-credential`, …) and `failure` its detail.",
      "404": missingResponse,
      "409": busyResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/thinking",
    operationId: "setSessionThinking",
    summary:
      "Turn extended thinking on or off for this session's next prompts. Binary, not levelled. Recorded in the session; a `session.state` envelope follows.",
    authenticated: true,
    requestBody: thinkingBody,
    responses: {
      "200": "`{ thinking }`.",
      "400": "The body is not `{ on: boolean }`.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/effort",
    operationId: "setSessionEffort",
    summary:
      "Set the reasoning effort for this session's next prompts, or `null` to return to the provider's default. Recorded in the session; a `session.state` envelope follows.",
    authenticated: true,
    requestBody: effortBody,
    responses: {
      "200": "`{ effort }`, `null` meaning the provider default.",
      "400": 'The body is not `{ level: "low" | "medium" | "high" | "xhigh" | "max" | null }`.',
      "404": missingResponse,
      "409": `${busyResponse} Only returning to the default needs an idle session.`,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/compact",
    operationId: "compactSession",
    summary:
      "Fold the older part of the conversation into a summary now, keeping the recent turns verbatim. `focus` steers what the summary keeps. The session continues over the shorter context; a `session.state` envelope follows.",
    authenticated: true,
    requestBody: compactBody,
    responses: {
      "200":
        "`{ compacted, notices }`: the compaction entry written, or `null` with a notice when there was nothing to fold.",
      "400": "The body is not `{ focus?: string }`.",
      "404": missingResponse,
      "409": busyResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/undo",
    operationId: "undoSession",
    summary:
      "Take back the last prompt: the conversation moves to just before it, its text comes back in `prompt` so a client can offer it for editing, and the files the turn changed are put back to the checkpoint taken before it. One undo is staged at a time; the next POST /redo cancels it. The undo is written to the session log as a `restore` entry, as POST /restore writes one, so a reopen finds the session rewound and POST /redo still takes it back after a server restart. With no prompt on the path, undoes the last file checkpoint alone. A `session.state` envelope follows.",
    authenticated: true,
    responses: {
      "200": "`{ prompt: { entryId, text } | null, filesNote, undoable, redoable }`.",
      "404": `${missingResponse} Or \`{ error: "nothing to undo" }\`.`,
      "409": busyResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/redo",
    operationId: "redoSession",
    summary:
      "Cancel the staged undo, restoring the transcript and the files, or redo the last file checkpoint when nothing is staged. A `session.state` envelope follows.",
    authenticated: true,
    responses: {
      "200": "`{ restored: true, undoable, redoable }`.",
      "404": `${missingResponse} Or \`{ error: "nothing to redo" }\`.`,
      "409": busyResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/restore",
    operationId: "restoreSessionTurn",
    summary:
      "Restore the session to just before one of its turns in one step, where POST /undo takes back one turn per call: the conversation moves to before that turn's prompt, and the workspace files go back to the checkpoint taken before the first change any turn from there on made (untouched when none of them changed a file, or with checkpoints off). One `restore` entry records it in the session log, `{ turn, from, files, redo }` with `redo` the snapshot of the files from before they went back, so a reopen finds the session where the restore left it and, even after a server restart, POST /redo can still put the files back. The answer says what changed: the turn's `prompt`, handed back so a client can offer it for editing; `undoneTurns`, how many turns left the active path; and `files`, every file the restore put back with the lines it `added` and `deleted`. Staged like an undo: the next POST /redo takes the whole restore back, files and conversation, and records a `restore-undone` entry so a reopen agrees. `session.state`, `session.tree` (reason `leaf`, naming the recorded entry) and, when files moved, `changes.updated` follow.",
    authenticated: true,
    requestBody: restoreBody,
    responses: {
      "200":
        "`{ turn, prompt: { entryId, text }, leafId, undoneTurns, files: [{ path, added, deleted }], filesNote, undoable, redoable }`; `leafId` is the recorded entry.",
      "400": "The body is not `{ turn }` with a positive integer.",
      "404": `${missingResponse} Or \`{ error: "no turn N on this session's path" }\`.`,
      "409": busyResponse,
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/restore",
    operationId: "previewSessionRestore",
    summary:
      "What `POST /sessions/{id}/restore` would do for `?turn=N`, without doing it, so a client can ask before it acts: the turn's `prompt`, how many turns would leave the active path (`undoneTurns`), every file the restore would put back with the lines it would `add` and `delete` (`files`, empty when no turn from there on changed a file or checkpoints are off), and `others`: the sessions of this workspace other than this one whose turns touched any of those files after that turn began, each as `{ sessionId, title, paths }`, so the question can name the work a restore would take from them. A restore resets the whole workspace to the checkpoint, theirs included. `others` comes from the turns those sessions settled (their `turn_facts`) plus the turn a live one is running now; edits made outside keywork are in `files` but never in `others`.",
    authenticated: true,
    responses: {
      "200":
        "`{ turn, prompt: { entryId, text }, undoneTurns, files: [{ path, added, deleted }], others: [{ sessionId, title, paths }] }`.",
      "400": "`turn` is not a positive integer.",
      "404": `${missingResponse} Or \`{ error: "no turn N on this session's path" }\`.`,
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/context",
    operationId: "readSessionContext",
    summary:
      "How full the model's context window is, as one reading every surface shows: `used` tokens of everything the next request carries (the sum of `parts` less `free`) against the `window`, with the points at which a memory flush (`flushAt`) and a compaction (`compactAt`) happen on the same axis. keywork's settler holds its reserves against the conversation, so the two lines sit at the window less the reserve plus what the system prompt and tool schemas take, and pass `window` when those outgrow the reserve. `basis` says where `used` comes from: `reported` once the provider has reported usage for the conversation so far (its count, plus an estimate of what arrived since), `estimated` from the text alone before that or after the history was rewritten, as a compaction, a flush, an undo or a forget does, so the reading right after any of them is a fresh measure of the shorter history and never the provider's older count. `declared` says whether the window came from keywork.json or is assumed. `parts` splits the same total, each as `{ tokens, basis }`: `system` (keywork's prompt and the configured prompts), `tools` (the tool schemas), `injected` (project instructions, the repo map, memory and extension context riding in the prompt), `conversation`, and `free` (the room left in the window). A part's `basis` is `reported` when it rests on what the provider reported for the last request, plus an estimate of what arrived since, and `estimated` when it comes from the text alone; the provider never splits its count, so `system`, `tools` and `injected` are always estimated. `thresholds` repeats `flushAt` and `compactAt` for clients that draw them across the parts.",
    authenticated: true,
    responses: {
      "200":
        '`ContextReading & { fullness, flushDue, compactionDue, basis: "reported" | "estimated", parts: { system, tools, injected, conversation, free }, thresholds: { flushAt, compactAt } }`, each part `{ tokens, basis: "reported" | "estimated" }`.',
      "404": missingResponse,
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/cost",
    operationId: "readSessionCost",
    summary:
      "What the session has spent under `keywork serve`, this process and the ones before it: each turn's usage is written on its assistant message in the session log, so a restart picks the totals back up. Token `usage`, the cost `rollup` in nanodollars with how many turns were priced, metered or unpriced, a `basis` line saying how honest the number is, the last `cacheMiss` if the provider reported one in this process, and the same split per model under `models`, which lists only models that ran at least one turn.",
    authenticated: true,
    responses: {
      "200":
        "`{ rollup, usage, basis, cacheMiss?, models: [{ reference, turns, usage, rollup }] }`.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/export",
    operationId: "exportSession",
    summary:
      'Render the session as a self-contained HTML page. `scope: "path"` (default) renders the active conversation; `"tree"` renders every branch. Without `out` the page is the response body; with `out`, a file or directory inside the workspace, the page is written there.',
    authenticated: true,
    requestBody: exportBody,
    responses: {
      "200": "The HTML page (`text/html`).",
      "201": "`{ file }`: where the page was written.",
      "400": 'The body is not `{ scope?: "path" | "tree", out?: string }`.',
      "403": "`out` escapes the workspace scope.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/rename",
    operationId: "renameSession",
    summary:
      "Give the session a title. A title set this way is pinned: the automatic titler that names a session from its first exchange will not replace it. A `session.state` envelope follows.",
    authenticated: true,
    requestBody: renameBody,
    responses: {
      "200": "`{ title }`.",
      "400": "The body is not `{ title: string }`.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/preset",
    operationId: "applyPreset",
    summary:
      "Switch the permission preset for this whole server process: `careful` asks before every core tool, `standard` follows the configured rules, `open` allows every core tool. Loosening (moving right in that order, or leaving a custom config) needs `confirmed: true`. The choice is saved to the user config and every live session sees a `gate.preset` event.",
    authenticated: true,
    requestBody: presetBody,
    responses: {
      "200": "`{ from, to }`.",
      "400": 'The body is not `{ name: "careful" | "standard" | "open", confirmed?: true }`.',
      "409": "Loosening needs `confirmed: true`.",
      "501": "This server was started without a preset switch.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const sessionVerbFamily = {
  routes: sessionVerbRoutes,
  handlers: ({ host, log }) => ({
    setSessionModel: async (request, { id }) => {
      const reference = nonBlank(
        fieldsOf<{ reference: unknown }>(await bodyOf(request))?.reference,
      );
      if (reference === undefined) {
        return json(400, { error: "the body must be { reference: string }" });
      }
      const outcome = await host.setModel(id ?? "", reference);
      if (typeof outcome === "string") return refused(outcome);
      if ("failure" in outcome) {
        const { failure } = outcome;
        return json(400, { error: failure.message, code: failure.code, failure });
      }
      return json(200, outcome);
    },
    setSessionThinking: async (request, { id }) => {
      const on = fieldsOf<{ on: unknown }>(await bodyOf(request))?.on;
      if (typeof on !== "boolean") return json(400, { error: "the body must be { on: boolean }" });
      const outcome = await host.setThinking(id ?? "", on);
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    setSessionEffort: async (request, { id }) => {
      const level = effortOf(await bodyOf(request));
      if (level === undefined) {
        return json(400, {
          error: `the body must be { level: ${effortLevels.map((word) => `"${word}"`).join(" | ")} | null }`,
        });
      }
      const outcome = await host.setEffort(id ?? "", level);
      return typeof outcome === "string" ? refused(outcome) : json(200, outcome);
    },
    compactSession: async (request, { id }) => {
      const fields = fieldsOf<{ focus: unknown }>(await bodyOf(request));
      const focus = fields?.focus;
      if (focus !== undefined && typeof focus !== "string") {
        return json(400, { error: "the body must be { focus?: string }" });
      }
      const outcome = await host.compact(id ?? "", focus);
      return typeof outcome === "string" ? refused(outcome) : json(200, outcome);
    },
    undoSession: async (_request, { id }) => {
      const outcome = await host.undo(id ?? "");
      if (outcome === "nothing") return json(404, { error: "nothing to undo" });
      return typeof outcome === "string" ? refused(outcome) : json(200, outcome);
    },
    redoSession: async (_request, { id }) => {
      const outcome = await host.redo(id ?? "");
      if (outcome === "nothing") return json(404, { error: "nothing to redo" });
      return typeof outcome === "string" ? refused(outcome) : json(200, outcome);
    },
    restoreSessionTurn: async (request, { id }) => {
      const turn = turnOf(await bodyOf(request));
      if (turn === undefined) {
        return json(400, { error: "the body must be { turn: a positive integer }" });
      }
      const outcome = await host.restore(id ?? "", turn);
      if (outcome === "unknown-turn") {
        return json(404, { error: `no turn ${turn} on this session's path` });
      }
      if (typeof outcome === "string") return refused(outcome);
      log.record(id ?? "", "session.tree", { reason: "leaf", entryId: outcome.leafId });
      return json(200, outcome);
    },
    previewSessionRestore: async (request, { id }) => {
      const turn = turnOf({ turn: Number(new URL(request.url).searchParams.get("turn")) });
      if (turn === undefined) return json(400, { error: "turn must be a positive integer" });
      const preview = await host.previewRestore(id ?? "", turn);
      if (preview === "missing") return missingSession();
      if (preview === "unknown-turn") {
        return json(404, { error: `no turn ${turn} on this session's path` });
      }
      return json(200, preview);
    },
    readSessionContext: async (_request, { id }) => {
      const reading = await host.context(id ?? "");
      return reading === "missing" ? missingSession() : json(200, contextAnswerOf(reading));
    },
    readSessionCost: async (_request, { id }) => {
      const report = await host.cost(id ?? "");
      return report === "missing" ? missingSession() : json(200, costAnswerOf(report));
    },
    exportSession: async (request, { id }) => {
      const exportRequest = exportRequestOf(await bodyOf(request));
      if (exportRequest === undefined) {
        return json(400, { error: 'the body must be { scope?: "path" | "tree", out?: string }' });
      }
      const outcome = await host.exportHtml(id ?? "", exportRequest.scope, exportRequest.out);
      if (outcome === "missing") return missingSession();
      if (outcome === "outside-scope") {
        return json(403, { error: "out escapes the workspace scope" });
      }
      return "file" in outcome ? json(201, outcome) : htmlPage(outcome.html);
    },
    renameSession: async (request, { id }) => {
      const title = nonBlank(fieldsOf<{ title: unknown }>(await bodyOf(request))?.title);
      if (title === undefined) return json(400, { error: "the body must be { title: string }" });
      const outcome = await host.rename(id ?? "", title);
      return outcome === "missing" ? missingSession() : json(200, outcome);
    },
    applyPreset: async (request) => {
      const choice = presetChoiceOf(await bodyOf(request));
      if (choice === undefined) {
        return json(400, {
          error: `the body must be { name: ${presetOrder.map((name) => `"${name}"`).join(" | ")}, confirmed?: true }`,
        });
      }
      const outcome = await host.applyPreset(choice.name, choice.confirmed);
      if (outcome === "needs-confirmation") {
        return json(409, { error: "loosening needs confirmed: true" });
      }
      if (outcome === "unavailable") {
        return json(501, { error: "this server was started without a preset switch" });
      }
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof sessionVerbRoutes>;

export function contextAnswerOf(reading: AgentContext): ContextAnswer {
  return {
    ...reading,
    fullness: contextFullness(reading),
    flushDue: flushDue(reading),
    compactionDue: compactionDue(reading),
  };
}

export function costAnswerOf(report: CostReport): CostAnswer {
  return { ...report, basis: costBasis(report.rollup, report.modelId) };
}

function refused(outcome: Refusal): Response {
  return outcome === "missing" ? missingSession() : json(409, { error: "a turn is running" });
}

function htmlPage(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function effortOf(body: unknown): EffortLevel | null | undefined {
  const fields = fieldsOf<{ level: unknown }>(body);
  if (fields === undefined || !("level" in fields)) return undefined;
  const { level } = fields;
  if (level === null) return null;
  return typeof level === "string" && isEffortLevel(level) ? level : undefined;
}

function turnOf(body: unknown): number | undefined {
  const turn = fieldsOf<{ turn: unknown }>(body)?.turn;
  return typeof turn === "number" && Number.isInteger(turn) && turn >= 1 ? turn : undefined;
}

function exportRequestOf(body: unknown): { scope: ExportScope; out?: string } | undefined {
  const fields = fieldsOf<{ scope: unknown; out: unknown }>(body) ?? {};
  const scope = fields.scope ?? "path";
  if (scope !== "path" && scope !== "tree") return undefined;
  if (fields.out === undefined) return { scope };
  const out = nonBlank(fields.out);
  return out === undefined ? undefined : { scope, out };
}

function presetChoiceOf(body: unknown): { name: PresetName; confirmed: boolean } | undefined {
  const fields = fieldsOf<{ name: unknown; confirmed: unknown }>(body);
  const name = fields?.name;
  if (typeof name !== "string" || !(presetOrder as readonly string[]).includes(name)) {
    return undefined;
  }
  if (fields?.confirmed !== undefined && fields.confirmed !== true) return undefined;
  return { name: name as PresetName, confirmed: fields?.confirmed === true };
}
