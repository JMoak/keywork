import {
  MockProvider,
  type Setting,
  SettingStore,
  type SettingStoreOptions,
  type ShowProposal,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { memorySessionHost } from "../testing.ts";
import type { RouteHandler, RouteParams } from "./family.ts";
import { recordedShowEvents, showFamily } from "./show.ts";

const origin = "http://127.0.0.1:4770";

function served(
  options: { show?: boolean } & Pick<SettingStoreOptions, "threads" | "hourlyLimit"> = {},
) {
  const { show, ...store } = options;
  const log = new EventLog();
  const settings = new SettingStore({
    clock: new FakeClock(Date.parse("2026-11-08T09:00:00Z")),
    emit: recordedShowEvents(log),
    ...store,
  });
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = show === false ? base : { ...base, show: settings };
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
      from: null,
      origin: "creature",
      ...overrides,
    });
    if ("refused" in outcome) throw new Error(outcome.error);
    return outcome.setting;
  };
  return { log, handlers, propose, settings };
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
});

describe("DELETE /show/{id}/signal", () => {
  const clear = (handlers: ReturnType<typeof served>["handlers"], id: string) =>
    call(handlers.clearSignal, "DELETE", `/show/${id}/signal`, { id });

  it("clears the signal, leaves the setting out and fires show.changed on its thread", async () => {
    const { handlers, propose, log } = served();
    const setting = propose({ sessionId: "s7", signal: "critical" });
    const { signal: _signal, ...quiet } = setting;

    expect(await clear(handlers, setting.id)).toEqual({ status: 200, body: { setting: quiet } });
    expect(
      log.since(0).map(({ sessionId, type, payload }) => ({ sessionId, type, payload })),
    ).toEqual([
      { sessionId: "s7", type: "show.proposed", payload: { setting } },
      { sessionId: "s7", type: "show.changed", payload: { setting: quiet } },
    ]);
    expect((await call(handlers.listSettings, "GET", "/show")).body).toEqual({ settings: [quiet] });
  });

  it("refuses an id not out with 404 and a setting with no signal with 409, firing nothing", async () => {
    const { handlers, propose, log } = served();
    const setting = propose();

    expect(await clear(handlers, "nope")).toEqual({
      status: 404,
      body: { refused: "missing", error: "no setting out has the id nope" },
    });
    expect(await clear(handlers, setting.id)).toEqual({
      status: 409,
      body: {
        refused: "conflict",
        error: `setting ${setting.id} carries no signal, so there is nothing to clear`,
      },
    });
    expect(log.since(0).map(({ type }) => type)).toEqual(["show.proposed"]);
  });
});

describe("POST /show", () => {
  const plan = { kind: "file", ref: "docs/plan.md" };
  const open = (handlers: ReturnType<typeof served>["handlers"], body: unknown) =>
    call(handlers.openSetting, "POST", "/show", {}, body);

  it("sets out the keeper's opening on the thread it grew from, answers 201 and fires show.proposed there", async () => {
    const { handlers, propose, log } = served();
    const diff = propose({ sessionId: "s7" });

    const answered = await open(handlers, { what: plan, from: diff.id, rung: "unfold" });

    const setting = {
      id: expect.any(String),
      creature: "wren",
      sessionId: "s7",
      what: plan,
      rung: "unfold",
      why: "",
      at: "2026-11-08T09:00:00.000Z",
      until: "seen",
      state: "live",
      from: diff.id,
      origin: "keeper",
      replaces: null,
    };
    expect(answered).toEqual({ status: 201, body: { setting } });
    expect(log.since(0).at(-1)).toMatchObject({
      sessionId: "s7",
      type: "show.proposed",
      payload: { setting },
    });
    expect((await call(handlers.listSettings, "GET", "/show")).body).toEqual({
      settings: [diff, setting],
    });
  });

  it("refuses a body outside its shape with 400 and an unknown from with 404, firing nothing", async () => {
    const { handlers, log } = served();

    for (const body of [
      undefined,
      { what: plan },
      { what: plan, from: "s1", rung: "card" },
      { what: { kind: "image", ref: "a.png" }, from: "s1" },
      { what: plan, from: "s1", why: "Because." },
    ]) {
      expect(await open(handlers, body)).toEqual({
        status: 400,
        body: {
          error: "the body is { what: { kind, ref, title? }, from, rung? } with rung unfold",
        },
      });
    }
    expect(await open(handlers, { what: plan, from: "nope" })).toEqual({
      status: 404,
      body: { refused: "missing", error: "no setting out and no thread has the id nope" },
    });
    expect(log.since(0)).toEqual([]);
  });
});

describe("PUT /sessions/{sessionId}/settings/placements", () => {
  const stage = { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false };
  const put = async (
    handlers: ReturnType<typeof served>["handlers"],
    sessionId: string,
    body: unknown,
  ) => {
    const response = await handlers.reportPlacements(
      new Request(`${origin}/sessions/${sessionId}/settings/placements`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { sessionId },
    );
    return { status: response.status, body: await response.text() };
  };

  it("keeps the session's whole picture, answers 204 with no body, and fires no event", async () => {
    const { handlers, propose, log, settings } = served();
    const setting = propose({ where: "outside" });
    const seat = { x: 6, y: 0, w: 6, h: 12 };

    const answered = await put(handlers, "s1", {
      stage,
      placements: [{ id: setting.id, where: "outside", seat, by: "keeper", later: true }],
      arrangement: { id: "a1", said: "Done." },
    });

    expect(answered).toEqual({ status: 204, body: "" });
    expect(settings.standingFor({ creature: "wren", sessionId: "s1" })).toEqual({
      out: [{ setting, where: "outside", seat, by: "keeper" }],
      stage,
    });
    expect(log.since(0).map(({ type }) => type)).toEqual(["show.proposed"]);
  });

  it("refuses a body outside its shape or a seat off the lattice with 400, and an unknown session with 404", async () => {
    const { handlers, propose } = served();
    const setting = propose();
    const placed = (overrides: object) => ({
      stage,
      placements: [{ id: setting.id, where: "outside", by: "console", ...overrides }],
    });

    for (const body of [
      undefined,
      { placements: [] },
      { stage: { ...stage, room: "moon" }, placements: [] },
      { stage: { ...stage, cardsAcross: 1.5 }, placements: [] },
      placed({ where: "upstairs" }),
      placed({ by: "nobody" }),
      placed({ seat: { x: 8, y: 0, w: 6, h: 12 } }),
      placed({ seat: { x: 0, y: 0, w: 6 } }),
      { ...placed({}), arrangement: { id: "a1" } },
    ]) {
      expect((await put(handlers, "s1", body)).status).toBe(400);
    }
    expect(await put(handlers, "nope", placed({}))).toEqual({
      status: 404,
      body: JSON.stringify({ refused: "missing", error: "no session has the id nope" }),
    });
  });
});
