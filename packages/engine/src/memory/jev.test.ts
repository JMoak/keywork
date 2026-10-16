import { describe, expect, it } from "vitest";
import type { FetchLike } from "../providers/transport.ts";
import {
  type JevAsk,
  type JevClientOptions,
  type JevFailure,
  jevBreaker,
  jevClient,
  jevModel,
  jevStateHash,
  typesafeEndpoint,
} from "./jev.ts";

const key = "ts-live-0123456789";

const ask: JevAsk = {
  state: { message: "Help! My payouts have been failing for 3 days." },
  questions: {
    is_urgent: {
      type: "noul",
      instructions: "Does this convey urgency?",
      criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
    },
  },
  pace: "sweep",
};

const answered = {
  model: jevModel,
  answers: { is_urgent: { type: "noul", noul: 0.95 } },
  usage: { input_tokens: 296, output_tokens: 20 },
};

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

function scripted(responses: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    sent.push({
      url,
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: String(init?.body),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response left");
    return next();
  };
  return { fetchFn, sent };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

function client(fetchFn: FetchLike, overrides: Partial<JevClientOptions> = {}) {
  return jevClient({ key, fetchFn, ...overrides });
}

describe("jevClient on the wire", () => {
  it("posts the pinned model, the state and the questions with the key only in the header", async () => {
    const { fetchFn, sent } = scripted([json(200, answered, { "x-typesafe-request-id": "req_1" })]);

    const reply = await client(fetchFn).ask(ask);

    expect(sent).toEqual([
      {
        url: `${typesafeEndpoint}/systemone`,
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model: jevModel, state: ask.state, questions: ask.questions }),
      },
    ]);
    expect(sent[0]?.body).not.toContain(key);
    expect(reply).toEqual({
      ok: true,
      answers: { is_urgent: { type: "noul", noul: 0.95 } },
      model: jevModel,
      inputTokens: 296,
      stateHash: jevStateHash(ask.state),
      requestId: "req_1",
    });
  });

  it("hashes exactly the state it sent", () => {
    expect(jevStateHash({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  it("speaks to whatever endpoint it is given, so a loopback decider is a registration", async () => {
    const { fetchFn, sent } = scripted([json(200, answered)]);
    await client(fetchFn, { endpoint: "http://127.0.0.1:8765/v1" }).ask(ask);
    expect(sent[0]?.url).toBe("http://127.0.0.1:8765/v1/systemone");
  });

  it("asks nothing without a key", async () => {
    const { fetchFn, sent } = scripted([]);
    expect(await jevClient({ key: undefined, fetchFn }).ask(ask)).toEqual({
      ok: false,
      reason: "no-key",
    });
    expect(await jevClient({ key: "", fetchFn }).ask(ask)).toEqual({
      ok: false,
      reason: "no-key",
    });
    expect(sent).toEqual([]);
  });
});

describe("jevClient failures", () => {
  it.each([
    [400, "malformed"],
    [413, "malformed"],
    [415, "malformed"],
    [422, "malformed"],
    [429, "rate-limited"],
    [529, "overloaded"],
    [500, "unreachable"],
    [503, "unreachable"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const { fetchFn } = scripted([
      json(status, { error: "max_tokens_exceeded" }, { "x-typesafe-request-id": "req_9" }),
    ]);
    expect(await client(fetchFn).ask(ask)).toEqual({
      ok: false,
      reason,
      status,
      stateHash: jevStateHash(ask.state),
      requestId: "req_9",
    });
  });

  it("calls a dropped connection unreachable", async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await client(fetchFn).ask(ask)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it.each([
    ["an unparsable body", () => new Response("<html>oops</html>", { status: 200 })],
    ["a missing answer", json(200, { ...answered, answers: {} })],
    [
      "an answer of the wrong type",
      json(200, {
        ...answered,
        answers: {
          is_urgent: { type: "choice", choice: "yes", probabilities: { yes: 1 }, confidence: 1 },
        },
      }),
    ],
    [
      "a probability past 1",
      json(200, { ...answered, answers: { is_urgent: { type: "noul", noul: 1.5 } } }),
    ],
    ["no usage", json(200, { model: jevModel, answers: answered.answers })],
  ])("calls %s malformed", async (_name, response) => {
    const { fetchFn } = scripted([response]);
    expect(await client(fetchFn).ask(ask)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses a choice outside the options it offered", async () => {
    const choiceAsk: JevAsk = {
      ...ask,
      questions: {
        verdict: { type: "choice", instructions: "Which?", criteria: { hold: "h", stale: "s" } },
      },
    };
    const { fetchFn } = scripted([
      json(200, {
        ...answered,
        answers: {
          verdict: {
            type: "choice",
            choice: "constructor",
            probabilities: { hold: 0.5 },
            confidence: 0.5,
          },
        },
      }),
    ]);
    expect(await client(fetchFn).ask(choiceAsk)).toMatchObject({ reason: "malformed" });
  });

  it("calls an answer from another model unproven, and keeps what it cost", async () => {
    const { fetchFn } = scripted([json(200, { ...answered, model: "jev-1.14.0" })]);
    expect(await client(fetchFn).ask(ask)).toEqual({
      ok: false,
      reason: "unproven-model",
      status: 200,
      model: "jev-1.14.0",
      inputTokens: 296,
      stateHash: jevStateHash(ask.state),
    });
  });

  it("gives up at the deadline and says late", async () => {
    const fetchFn: FetchLike = () => new Promise<Response>(() => {});
    const reply = await client(fetchFn, { deadlines: { sweepMs: 20, hotPathMs: 10 } }).ask(ask);
    expect(reply).toEqual({ ok: false, reason: "late", stateHash: jevStateHash(ask.state) });
  });

  it("aborts the request it gave up on", async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: FetchLike = (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    await client(fetchFn, { deadlines: { hotPathMs: 10 } }).ask({ ...ask, pace: "hot-path" });
    expect(signal?.aborted).toBe(true);
  });
});

describe("jevClient retries", () => {
  it("never retries on the hot path, retry-after or not", async () => {
    const { fetchFn, sent } = scripted([
      json(429, {}, { "retry-after": "0" }),
      json(200, answered),
    ]);
    const reply = await client(fetchFn).ask({ ...ask, pace: "hot-path" });
    expect(reply).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(sent).toHaveLength(1);
  });

  it("honors one retry-after inside a sweep's deadline", async () => {
    const waits: number[] = [];
    const { fetchFn, sent } = scripted([
      json(529, {}, { "retry-after": "1" }),
      json(200, answered),
    ]);
    const reply = await client(fetchFn, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).ask(ask);
    expect(reply.ok).toBe(true);
    expect(waits).toEqual([1000]);
    expect(sent).toHaveLength(2);
  });

  it("falls back when the retry-after would outlast the sweep's deadline", async () => {
    const { fetchFn, sent } = scripted([json(429, {}, { "retry-after": "9" })]);
    const reply = await client(fetchFn, { sleep: async () => {} }).ask(ask);
    expect(reply).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(sent).toHaveLength(1);
  });
});

describe("jevClient latches", () => {
  it("stops asking after TypeSafe refuses the key, and reports the refusal once", async () => {
    const reported: JevFailure[] = [];
    const { fetchFn, sent } = scripted([json(401, { error: "invalid key" })]);
    const refusing = client(fetchFn, { onFailure: (failure) => reported.push(failure) });

    expect(await refusing.ask(ask)).toMatchObject({ ok: false, reason: "refused", status: 401 });
    expect(await refusing.ask(ask)).toEqual({ ok: false, reason: "refused" });
    expect(sent).toHaveLength(1);
    expect(reported.map((failure) => failure.reason)).toEqual(["refused"]);
  });

  it("opens the breaker after three failures in a row and closes it after a minute", async () => {
    let now = 1_000;
    const failing = Array.from({ length: jevBreaker.failures }, () => json(503, {}));
    const { fetchFn, sent } = scripted([...failing, json(200, answered)]);
    const breaking = client(fetchFn, { clock: () => now });

    for (const _ of failing) await breaking.ask(ask);
    expect(await breaking.ask(ask)).toEqual({ ok: false, reason: "degraded" });
    expect(sent).toHaveLength(jevBreaker.failures);

    now += jevBreaker.openMs;
    expect((await breaking.ask(ask)).ok).toBe(true);
  });

  it("forgets a failure streak once an answer arrives", async () => {
    const { fetchFn, sent } = scripted([
      json(503, {}),
      json(503, {}),
      json(200, answered),
      json(503, {}),
      json(503, {}),
      json(200, answered),
    ]);
    const steady = client(fetchFn, { clock: () => 0 });
    const reasons: string[] = [];
    for (let call = 0; call < 6; call += 1) {
      const reply = await steady.ask(ask);
      reasons.push(reply.ok ? "answered" : reply.reason);
    }
    expect(reasons).toEqual([
      "unreachable",
      "unreachable",
      "answered",
      "unreachable",
      "unreachable",
      "answered",
    ]);
    expect(sent).toHaveLength(6);
  });
});
