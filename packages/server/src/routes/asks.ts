import type { AskScope } from "@keywork/shared";
import type { AnswerOutcome, AskVerdict } from "../asks.ts";
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

const askAnswerBody: JsonSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["granted", "denied"] },
    scope: { type: "string", enum: [...askScopes], default: "once" },
  },
  additionalProperties: false,
};

export const askRoutes = [
  {
    method: "GET",
    path: "/asks",
    operationId: "listAsks",
    summary:
      "Tool calls waiting on a person: every unanswered `gate.ask`, oldest first. Each carries `rules`, what a `session` or `workspace` answer would record.",
    authenticated: true,
    responses: { "200": "The pending asks." },
  },
  {
    method: "POST",
    path: "/asks/{callId}",
    operationId: "answerAsk",
    summary:
      'Answer a pending ask. The turn resumes with the verdict and reports it as `gate.permission` with `gate: "user"` and the `scope` of a grant. `scope` defaults to `once`; `session` records the ask\'s `rules` for the rest of this session and `workspace` records them for every session of this workspace (see `GET /permissions`). A denial ignores `scope`. Only `bash` and MCP calls can be granted beyond `once`.',
    authenticated: true,
    requestBody: askAnswerBody,
    responses: {
      "200": "The ask was settled.",
      "400":
        'The body is not `{ verdict: "granted" | "denied", scope?: "once" | "session" | "workspace" }`, or the call cannot be granted beyond `once` (`write` and `edit` never can, nor a command with no part to remember).',
      "404": "No ask with that callId is pending.",
      "409": "That ask was already answered or timed out.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const askFamily = {
  routes: askRoutes,
  handlers: ({ host }) => ({
    listAsks: async () => json(200, { asks: await host.asks() }),
    answerAsk: async (request, { callId }) => {
      const answer = askAnswerOf(await bodyOf(request));
      if (answer === undefined) {
        return json(400, {
          error:
            'the body must be { verdict: "granted" | "denied", scope?: "once" | "session" | "workspace" }',
        });
      }
      const outcome = await host.answerAsk(callId ?? "", answer.verdict, answer.scope);
      return outcome === "settled" ? json(200, { callId, settled: true }) : refusalOf(outcome);
    },
  }),
} satisfies RouteFamily<typeof askRoutes>;

interface AskAnswer {
  verdict: AskVerdict;
  scope: AskScope;
}

function askAnswerOf(body: unknown): AskAnswer | undefined {
  const fields = fieldsOf<{ verdict: unknown; scope: unknown }>(body);
  const verdict = fields?.verdict;
  const scope = fields?.scope ?? "once";
  if (verdict !== "granted" && verdict !== "denied") return undefined;
  return isAskScope(scope) ? { verdict, scope } : undefined;
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
