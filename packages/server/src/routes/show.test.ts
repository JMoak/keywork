import { MockProvider, type Setting, SettingStore, type ShowProposal } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { contractVersion } from "../contract.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { memorySessionHost } from "../testing.ts";
import type { RouteHandler, RouteParams } from "./family.ts";
import { recordedShowEvents, showFamily } from "./show.ts";

const origin = "http://127.0.0.1:4770";

function served(options: { show?: boolean } = {}) {
  const log = new EventLog();
  const settings = new SettingStore({
    clock: new FakeClock(Date.parse("2026-11-08T09:00:00Z")),
    emit: recordedShowEvents(log),
  });
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = options.show === false ? base : { ...base, show: settings };
  const handlers = showFamily((host) => host.show).handlers({
    host,
    log,
    streams: { add: () => () => undefined },
    describe: fixtureDocument,
  });
  const propose = (overrides: Partial<ShowProposal> = {}): Setting => {
    const outcome = settings.propose({
      creature: "wren",
      sessionId: "s1",
      what: { kind: "diff", ref: "c1" },
      rung: "card",
      why: "The fix is ready for your eyes.",
      until: "seen",
      ...overrides,
    });
    if ("refused" in outcome) throw new Error(outcome.error);
    return outcome.setting;
  };
  return { log, handlers, propose };
}

async function call(
  handler: RouteHandler,
  method: string,
  path: string,
  params: RouteParams = {},
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${origin}${path}`, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    }),
    params,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET /show", () => {
  it("seats every setting still out on a cold start, live and pinned, oldest first", async () => {
    const { handlers, propose } = served();
    const first = propose();
    const pinned = propose({ what: { kind: "file", ref: "docs/plan.md", title: "The plan" } });
    const seen = propose({ sessionId: "s2", what: { kind: "note", ref: "Lunch at noon." } });
    await call(handlers.answerSetting, "POST", "", { id: pinned.id }, { outcome: "pinned" });
    await call(handlers.answerSetting, "POST", "", { id: seen.id }, { outcome: "seen" });

    const listed = await call(handlers.listSettings, "GET", "/show");

    expect(listed).toEqual({
      status: 200,
      body: { settings: [first, { ...pinned, state: "pinned" }] },
    });
  });

  it("answers 503 on a host that serves no settings", async () => {
    const { handlers } = served({ show: false });
    expect(await call(handlers.listSettings, "GET", "/show")).toEqual({
      status: 503,
      body: { error: "settings is not served by this host" },
    });
  });
});

describe("POST /show/{id}/answer", () => {
  it("records the keeper's outcome and fires show.settled on the setting's thread", async () => {
    const { handlers, propose, log } = served();
    const setting = propose({ sessionId: "s7" });

    const answered = await call(
      handlers.answerSetting,
      "POST",
      `/show/${setting.id}/answer`,
      { id: setting.id },
      { outcome: "dismissed" },
    );

    expect(answered).toEqual({
      status: 200,
      body: { setting: { ...setting, state: "dismissed" } },
    });
    expect(
      log.since(0).map(({ sessionId, type, payload }) => ({ sessionId, type, payload })),
    ).toEqual([
      { sessionId: "s7", type: "show.proposed", payload: { setting } },
      {
        sessionId: "s7",
        type: "show.settled",
        payload: { id: setting.id, outcome: "dismissed", by: "keeper" },
      },
    ]);
    expect((await call(handlers.listSettings, "GET", "/show")).body).toEqual({ settings: [] });
  });

  it("refuses a body that is not an outcome, an id not out and an answer that moves nothing", async () => {
    const { handlers, propose, log } = served();
    const setting = propose();
    const answer = (id: string, body: unknown) =>
      call(handlers.answerSetting, "POST", `/show/${id}/answer`, { id }, body);

    expect(await answer(setting.id, { outcome: "withdrawn" })).toEqual({
      status: 400,
      body: { error: "the body is { outcome } with seen, pinned, unpinned or dismissed" },
    });
    expect((await answer(setting.id, undefined)).status).toBe(400);
    expect(await answer("nope", { outcome: "seen" })).toEqual({
      status: 404,
      body: { refused: "missing", error: "no setting out has the id nope" },
    });
    expect(await answer(setting.id, { outcome: "unpinned" })).toEqual({
      status: 409,
      body: {
        refused: "conflict",
        error: `setting ${setting.id} is not pinned, so there is nothing to unpin`,
      },
    });
    expect(log.since(0).map(({ type }) => type)).toEqual(["show.proposed"]);
  });

  it("answers 503 on a host that serves no settings", async () => {
    const { handlers } = served({ show: false });
    const answered = await call(
      handlers.answerSetting,
      "POST",
      "/show/x/answer",
      { id: "x" },
      { outcome: "seen" },
    );
    expect(answered.status).toBe(503);
  });
});

describe("the contract", () => {
  it("is 1.27 and lists both show routes in /doc", () => {
    const { paths } = fixtureDocument();
    expect(contractVersion).toBe("1.27");
    expect(paths["/show"]?.get?.operationId).toBe("listSettings");
    expect(paths["/show/{id}/answer"]?.post?.operationId).toBe("answerSetting");
  });
});
