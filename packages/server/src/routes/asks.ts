import type { AskVerdict } from "../asks.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const askAnswerBody: JsonSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["granted", "denied"] } },
  additionalProperties: false,
};

export const askRoutes = [
  {
    method: "GET",
    path: "/asks",
    operationId: "listAsks",
    summary: "Tool calls waiting on a person: every unanswered `gate.ask`, oldest first.",
    authenticated: true,
    responses: { "200": "The pending asks." },
  },
  {
    method: "POST",
    path: "/asks/{callId}",
    operationId: "answerAsk",
    summary:
      'Answer a pending ask. The turn resumes with the verdict and reports it as `gate.permission` with `gate: "user"`.',
    authenticated: true,
    requestBody: askAnswerBody,
    responses: {
      "200": "The ask was settled.",
      "400": 'The body is not `{ verdict: "granted" | "denied" }`.',
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
      const verdict = askVerdictOf(await bodyOf(request));
      if (verdict === undefined) {
        return json(400, { error: 'the body must be { verdict: "granted" | "denied" }' });
      }
      const outcome = await host.answerAsk(callId ?? "", verdict);
      if (outcome === "missing") return json(404, { error: "no ask with that callId is pending" });
      if (outcome === "already-settled") {
        return json(409, { error: "that ask was already answered or timed out" });
      }
      return json(200, { callId, settled: true });
    },
  }),
} satisfies RouteFamily<typeof askRoutes>;

function askVerdictOf(body: unknown): AskVerdict | undefined {
  const verdict = fieldsOf<{ verdict: unknown }>(body)?.verdict;
  return verdict === "granted" || verdict === "denied" ? verdict : undefined;
}
