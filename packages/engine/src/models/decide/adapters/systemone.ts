import { z } from "zod";
import type { ModelReference } from "../../../inference/types.ts";
import { type AuthHeaders, bearerHeaders, type FetchLike } from "../../../providers/transport.ts";
import type {
  DecideFailureReason,
  DecideReply,
  Decider,
  DecisionAnswer,
  DecisionCost,
  DecisionQuestion,
  DecisionRequest,
} from "../types.ts";

export interface SystemOneOptions {
  reference: ModelReference;
  endpoint: string;
  authHeaders?: AuthHeaders | undefined;
  fetchFn?: FetchLike | undefined;
  clock?: (() => number) | undefined;
  pricePerMillionInput?: number | undefined;
}

export function systemOneDecider(options: SystemOneOptions): Decider {
  const url = systemOneUrl(options.endpoint);
  const clock = options.clock ?? (() => performance.now());
  return {
    reference: options.reference,
    decide: async (request) => {
      const started = clock();
      const body = wireRequestOf(options.reference.model, request);
      const exchange = await post(url, body, options, request.signal);
      if (exchange.kind === "unreachable") return failed("unreachable", exchange.message);
      if (exchange.status < 200 || exchange.status > 299) {
        const reason = reasonForStatus(exchange.status, exchange.text);
        return failed(reason, exchange.text.slice(0, 300), exchange.status);
      }
      return replyOf(exchange.text, request, options, clock() - started);
    },
  };
}

export function systemOneUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/systemone` : `${base}/v1/systemone`;
}

export function wireRequestOf(model: string, request: DecisionRequest): string {
  return JSON.stringify({ model, state: request.state, questions: request.questions });
}

type Exchange =
  | { kind: "unreachable"; message: string }
  | { kind: "response"; status: number; text: string };

async function post(
  url: string,
  body: string,
  options: SystemOneOptions,
  signal?: AbortSignal,
): Promise<Exchange> {
  try {
    const auth = await (options.authHeaders ?? bearerHeaders(undefined))();
    const response = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...auth },
      body,
      ...(signal !== undefined && { signal }),
    });
    return { kind: "response", status: response.status, text: await response.text() };
  } catch (error) {
    return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
}

function reasonForStatus(status: number, text: string): DecideFailureReason {
  if (status === 401 || status === 403) return "refused";
  if (status === 404 || /not found/i.test(text)) return "model-not-found";
  if (status === 429) return "rate-limited";
  if (status === 503) return "saturated";
  if (status === 529) return "overloaded";
  if (status >= 500) return "unreachable";
  return "rejected";
}

const probability = z.number().min(0).max(1);

const wireAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), probability),
  }),
]);

type WireAnswer = z.infer<typeof wireAnswer>;

const wireReply = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), wireAnswer),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

class MalformedReply extends Error {}

function replyOf(
  text: string,
  request: DecisionRequest,
  options: SystemOneOptions,
  latencyMs: number,
): DecideReply {
  const parsed = wireReply.safeParse(parsedJson(text));
  if (!parsed.success) return failed("malformed", "reply does not match the System One shape");
  try {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        answerOf(id, question, parsed.data.answers[id]),
      ]),
    );
    const inputTokens = parsed.data.usage?.input_tokens ?? null;
    return {
      ok: true,
      model: parsed.data.model ?? options.reference.model,
      answers,
      usage: {
        inputTokens,
        questions: Object.keys(request.questions).length,
        cost: costOf(parsed.data.usage?.cost, inputTokens, options.pricePerMillionInput),
      },
      latencyMs,
    };
  } catch (error) {
    if (error instanceof MalformedReply) return failed("malformed", error.message);
    throw error;
  }
}

function answerOf(
  id: string,
  question: DecisionQuestion,
  answer: WireAnswer | undefined,
): DecisionAnswer {
  if (answer === undefined) throw new MalformedReply(`${id}: no answer`);
  switch (question.type) {
    case "noul":
      return noulAnswer(id, answer);
    case "choice":
      return choiceAnswer(id, Object.keys(question.criteria), answer);
    case "score":
      return scoreAnswer(id, question.criteria.length, answer);
  }
}

function noulAnswer(id: string, answer: WireAnswer): DecisionAnswer {
  if (answer.type !== "noul") throw mismatch(id, "noul", answer.type);
  return { type: "noul", pYes: answer.noul, confidence: Math.max(answer.noul, 1 - answer.noul) };
}

function choiceAnswer(id: string, options: readonly string[], answer: WireAnswer): DecisionAnswer {
  if (answer.type !== "choice") throw mismatch(id, "choice", answer.type);
  const probabilities = distribution(id, options, answer.probabilities);
  const ranked = options.map((option, i) => ({ option, p: probabilities[i] ?? 0 }));
  const leading = ranked.reduce((best, next) => (next.p > best.p ? next : best));
  return {
    type: "choice",
    choice: leading.option,
    probabilities: Object.fromEntries(ranked.map(({ option, p }) => [option, p])),
    confidence: leading.p,
  };
}

function scoreAnswer(id: string, levels: number, answer: WireAnswer): DecisionAnswer {
  if (answer.type !== "score") throw mismatch(id, "score", answer.type);
  const keys = Array.from({ length: levels }, (_, i) => String(i));
  const probabilities = distribution(id, keys, answer.probabilities);
  return {
    type: "score",
    score: answer.score,
    probabilities,
    confidence: Math.max(...probabilities),
  };
}

function mismatch(id: string, expected: string, got: string): MalformedReply {
  return new MalformedReply(`${id}: expected ${expected}, got ${got}`);
}

function distribution(
  id: string,
  keys: readonly string[],
  reported: Readonly<Record<string, number>>,
): number[] {
  if (Object.keys(reported).length !== keys.length) {
    throw new MalformedReply(`${id}: probabilities name other answers than were asked`);
  }
  const probabilities = keys.map((key) => {
    const p = reported[key];
    if (p === undefined) throw new MalformedReply(`${id}: no probability for ${key}`);
    return p;
  });
  const total = probabilities.reduce((sum, p) => sum + p, 0);
  if (!(total > 0) || Math.abs(total - 1) > keys.length * roundingPerEntry) {
    throw new MalformedReply(`${id}: probabilities sum to ${total}`);
  }
  return probabilities.map((p) => p / total);
}

const roundingPerEntry = 0.005 + Number.EPSILON;

function costOf(
  reported: number | undefined,
  inputTokens: number | null,
  pricePerMillionInput: number | undefined,
): DecisionCost | null {
  if (reported !== undefined) return { usd: reported, source: "provider" };
  if (inputTokens === null || pricePerMillionInput === undefined) return null;
  return { usd: (inputTokens * pricePerMillionInput) / 1e6, source: "price_table" };
}

function failed(reason: DecideFailureReason, message: string, status?: number): DecideReply {
  return { ok: false, failure: { reason, message, ...(status !== undefined && { status }) } };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
