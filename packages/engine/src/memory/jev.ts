import { createHash } from "node:crypto";
import { z } from "zod";
import type { FetchLike } from "../providers/transport.ts";
import type { FallbackReason } from "./decider.ts";

export const jevModel = "jev-1.13.0";

export const typesafeEndpoint = "https://api.typesafe.ai/v1";

export const jevDeadlines: JevDeadlines = { hotPathMs: 150, sweepMs: 5_000 };

export const jevBreaker = { failures: 3, openMs: 60_000 } as const;

export interface JevDeadlines {
  hotPathMs: number;
  sweepMs: number;
}

export type JevPace = "hot-path" | "sweep";

export type JevJson = string | number | boolean | null | readonly JevJson[] | JevObject;

export interface JevObject {
  readonly [field: string]: JevJson;
}

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> };

export interface JevAsk {
  state: JevObject;
  questions: Readonly<Record<string, JevQuestion>>;
  pace: JevPace;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    };

export type JevFailureReason = Exclude<FallbackReason, "undecided">;

export type JevReply = JevAnswered | JevFailure;

export interface JevAnswered {
  ok: true;
  answers: Readonly<Record<string, JevAnswer>>;
  model: string;
  inputTokens: number;
  stateHash: string;
  requestId?: string;
}

export interface JevFailure {
  ok: false;
  reason: JevFailureReason;
  status?: number;
  model?: string;
  inputTokens?: number;
  stateHash?: string;
  requestId?: string;
}

export interface JevClient {
  readonly model: string;
  ask(ask: JevAsk): Promise<JevReply>;
}

export interface JevClientOptions {
  key: string | undefined;
  endpoint?: string;
  fetchFn?: FetchLike;
  deadlines?: Partial<JevDeadlines>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (failure: JevFailure) => void;
}

export function jevClient(options: JevClientOptions): JevClient {
  const clock = options.clock ?? Date.now;
  const breaker = failureBreaker(clock);
  let refused = false;
  return {
    model: jevModel,
    ask: async (ask) => {
      if (options.key === undefined || options.key === "") return { ok: false, reason: "no-key" };
      if (refused) return { ok: false, reason: "refused" };
      if (breaker.isOpen()) return { ok: false, reason: "degraded" };
      const reply = await exchange(ask, options.key, options, clock);
      if (reply.ok) {
        breaker.recordSuccess();
        return reply;
      }
      if (reply.reason === "refused") refused = true;
      else breaker.recordFailure();
      options.onFailure?.(reply);
      return reply;
    },
  };
}

export function jevStateHash(state: JevObject): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

type Attempt =
  | { kind: "late" }
  | { kind: "unreachable" }
  | {
      kind: "response";
      status: number;
      payload: unknown;
      requestId: string | undefined;
      retryAfterMs: number | undefined;
    };

async function exchange(
  ask: JevAsk,
  key: string,
  options: JevClientOptions,
  clock: () => number,
): Promise<JevReply> {
  const url = `${options.endpoint ?? typesafeEndpoint}/systemone`;
  const body = JSON.stringify({ model: jevModel, state: ask.state, questions: ask.questions });
  const budgetMs = deadlineFor(ask.pace, options.deadlines);
  const started = clock();
  const remaining = (): number => budgetMs - (clock() - started);
  const send = (): Promise<Attempt> =>
    attemptWithin(remaining(), (signal) => post(url, key, body, signal, options.fetchFn ?? fetch));
  let attempt = await send();
  const wait = honoredRetryAfter(attempt, ask.pace, remaining());
  if (wait !== undefined) {
    await (options.sleep ?? sleepFor)(wait);
    attempt = await send();
  }
  return replyOf(attempt, ask, jevStateHash(ask.state));
}

function deadlineFor(pace: JevPace, overrides: Partial<JevDeadlines> | undefined): number {
  const deadlines = { ...jevDeadlines, ...overrides };
  return pace === "hot-path" ? deadlines.hotPathMs : deadlines.sweepMs;
}

async function attemptWithin(
  budgetMs: number,
  attempt: (signal: AbortSignal) => Promise<Attempt>,
): Promise<Attempt> {
  if (budgetMs <= 0) return { kind: "late" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Attempt>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "late" });
      controller.abort();
    }, budgetMs);
  });
  const answered = attempt(controller.signal).catch((): Attempt => ({ kind: "unreachable" }));
  try {
    return await Promise.race([answered, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function post(
  url: string,
  key: string,
  body: string,
  signal: AbortSignal,
  fetchFn: FetchLike,
): Promise<Attempt> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
    signal,
  });
  const text = await response.text();
  return {
    kind: "response",
    status: response.status,
    payload: parsedJson(text),
    requestId: response.headers.get("x-typesafe-request-id") ?? undefined,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  };
}

function honoredRetryAfter(
  attempt: Attempt,
  pace: JevPace,
  remainingMs: number,
): number | undefined {
  if (pace !== "sweep" || attempt.kind !== "response") return undefined;
  if (attempt.status !== 429 && attempt.status !== 529) return undefined;
  const wait = attempt.retryAfterMs;
  return wait !== undefined && wait < remainingMs ? wait : undefined;
}

function replyOf(attempt: Attempt, ask: JevAsk, stateHash: string): JevReply {
  if (attempt.kind !== "response") return { ok: false, reason: attempt.kind, stateHash };
  const { status } = attempt;
  const facts = {
    stateHash,
    ...(attempt.requestId !== undefined && { requestId: attempt.requestId }),
  };
  if (status < 200 || status > 299)
    return { ok: false, reason: failureOfStatus(status), status, ...facts };
  const parsed = replySchema.safeParse(attempt.payload);
  if (!parsed.success || !answersFit(ask.questions, parsed.data.answers))
    return { ok: false, reason: "malformed", status, ...facts };
  const { model, answers, usage } = parsed.data;
  const inputTokens = usage.input_tokens;
  if (model !== jevModel)
    return { ok: false, reason: "unproven-model", status, model, inputTokens, ...facts };
  return { ok: true, answers, model, inputTokens, ...facts };
}

function failureOfStatus(status: number): JevFailureReason {
  if (status === 401 || status === 403) return "refused";
  if (status === 429) return "rate-limited";
  if (status === 529) return "overloaded";
  if (status >= 500) return "unreachable";
  return "malformed";
}

const probability = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
]);

const replySchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }),
});

function answersFit(
  questions: Readonly<Record<string, JevQuestion>>,
  answers: Readonly<Record<string, JevAnswer>>,
): boolean {
  return Object.entries(questions).every(([key, question]) => {
    const answer = answers[key];
    if (answer?.type !== question.type) return false;
    return answer.type === "noul" || Object.keys(question.criteria).includes(answer.choice);
  });
}

function failureBreaker(clock: () => number) {
  let consecutive = 0;
  let openUntil = Number.NEGATIVE_INFINITY;
  return {
    isOpen: (): boolean => clock() < openUntil,
    recordSuccess: (): void => {
      consecutive = 0;
    },
    recordFailure: (): void => {
      consecutive += 1;
      if (consecutive < jevBreaker.failures) return;
      consecutive = 0;
      openUntil = clock() + jevBreaker.openMs;
    },
  };
}

function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
