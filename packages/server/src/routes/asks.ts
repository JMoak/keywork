import type { AskScope } from "@keywork/shared";
import type { AnswerOutcome, AskVerdict, Denial, DenyReason } from "../asks.ts";
import { surfaceChanged } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export const askRefusals = {
  "write-once": "write and edit are approved once at a time",
  "nothing-to-remember": "this call has nothing a grant could remember; approve it once",
} as const;

const askScopes = ["once", "session", "workspace"] as const satisfies readonly AskScope[];
const denyReasons = ["unsafe", "not-now", "other"] as const satisfies readonly DenyReason[];

const maxDenialNoteChars = 1000;

const askAnswerBody: JsonSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["granted", "denied"] },
    scope: { type: "string", enum: [...askScopes], default: "once" },
    reason: { type: "string", enum: [...denyReasons] },
    note: { type: "string", minLength: 1, maxLength: maxDenialNoteChars },
  },
  additionalProperties: false,
};

const askAnswerShape = `{ verdict: "granted" | "denied", scope?: "once" | "session" | "workspace", reason?: "unsafe" | "not-now" | "other", note?: string }`;

export const askRoutes = [
  {
    method: "GET",
    path: "/asks",
    operationId: "listAsks",
    summary:
      "Tool calls waiting on a person: every unanswered `gate.ask`, oldest first. Each carries `rules`, what a `session` or `workspace` answer would record, and for a `write` or `edit` the same `preview` its `gate.ask` carried: `{ path, before, after }`, the file as it is and as the call would leave it.",
    authenticated: true,
    responses: { "200": "The pending asks." },
  },
  {
    method: "POST",
    path: "/asks/{callId}",
    operationId: "answerAsk",
    summary:
      'Answer a pending ask. The turn resumes with the verdict and reports it as `gate.permission` with `gate: "user"` and the `scope` of a grant. `scope` defaults to `once`; `session` records the ask\'s `rules` for the rest of this session and `workspace` records them for every session of this workspace (see `GET /permissions`). A denial ignores `scope` and may say why with `reason`: `unsafe` (the call should not run), `not-now` (the moment, not the call) or `other`, and in the person\'s own words with `note` (at most 1000 characters, the free text an `other` answer asks for). Both reach the model in the refused call\'s result, with a line telling it not to retry the call and not to report it as done, and ride on the `gate.permission` decision and in the journal. A grant ignores `reason` and `note`. Only `bash` and MCP calls can be granted beyond `once`. A grant beyond `once` fires `surface.changed` with `kind: "permissions"`.',
    authenticated: true,
    requestBody: askAnswerBody,
    responses: {
      "200": "The ask was settled.",
      "400": `The body is not \`${askAnswerShape}\`, or the call cannot be granted beyond \`once\` (\`write\` and \`edit\` never can, nor a command with no part to remember).`,
      "404": "No ask with that callId is pending.",
      "409": "That ask was already answered or timed out.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const askFamily = {
  routes: askRoutes,
  handlers: ({ host, log }) => ({
    listAsks: async () => json(200, { asks: await host.asks() }),
    answerAsk: async (request, { callId }) => {
      const answer = askAnswerOf(await bodyOf(request));
      if (answer === undefined) {
        return json(400, { error: `the body must be ${askAnswerShape}` });
      }
      const outcome = await host.answerAsk(
        callId ?? "",
        answer.verdict,
        answer.scope,
        answer.denial,
      );
      if (outcome !== "settled") return refusalOf(outcome);
      if (recordsGrant(answer)) surfaceChanged(log, "permissions");
      return json(200, { callId, settled: true });
    },
  }),
} satisfies RouteFamily<typeof askRoutes>;

interface AskAnswer {
  verdict: AskVerdict;
  scope: AskScope;
  denial: Denial;
}

function askAnswerOf(body: unknown): AskAnswer | undefined {
  const fields = fieldsOf<{ verdict: unknown; scope: unknown; reason: unknown; note: unknown }>(
    body,
  );
  const verdict = fields?.verdict;
  const scope = fields?.scope ?? "once";
  if (verdict !== "granted" && verdict !== "denied") return undefined;
  if (!isAskScope(scope)) return undefined;
  const denial = denialOf(fields?.reason, fields?.note);
  return denial === undefined ? undefined : { verdict, scope, denial };
}

function denialOf(reason: unknown, note: unknown): Denial | undefined {
  if (reason !== undefined && !isDenyReason(reason)) return undefined;
  if (note !== undefined && !isDenialNote(note)) return undefined;
  return {
    ...(reason !== undefined && { reason }),
    ...(note !== undefined && { note: note.trim() }),
  };
}

function isDenyReason(reason: unknown): reason is DenyReason {
  return (denyReasons as readonly unknown[]).includes(reason);
}

function isDenialNote(note: unknown): note is string {
  return typeof note === "string" && note.trim() !== "" && note.length <= maxDenialNoteChars;
}

function recordsGrant({ verdict, scope }: AskAnswer): boolean {
  return verdict === "granted" && scope !== "once";
}

function isAskScope(scope: unknown): scope is AskScope {
  return (askScopes as readonly unknown[]).includes(scope);
}

function refusalOf(outcome: Exclude<AnswerOutcome, "settled">): Response {
  switch (outcome) {
    case "missing":
      return json(404, { error: "no ask with that callId is pending" });
    case "already-settled":
      return json(409, { error: "that ask was already answered or timed out" });
    case "write-once":
    case "nothing-to-remember":
      return json(400, { error: askRefusals[outcome] });
  }
}
