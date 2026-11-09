import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Message,
  MockProvider,
  messageText,
  type Provider,
  type ProviderRequest,
  type Setting,
  type TurnDelta,
  textTurn,
  toolCallTurn,
  yardPrompt,
} from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../engine/src/routines/testing.ts";
import { serve, servedHost } from "./serve.ts";
import { servedSettings, workspaceSettingsFile } from "./serve-show.ts";
import { findSession } from "./sessions/store.ts";

const scratch = scratchDirs("keywork-serve-show-");
const token = "show-token";
const t0 = Date.parse("2026-11-08T09:00:00Z");
const minuteMs = 60_000;
const hourlyLimit = 5;

describe("a served workspace's settings", () => {
  it("come back exactly after the host stops and starts, pins and lineage included, past their time gone, the hour still counted", async () => {
    const place = await workspacePlace();
    const before = await startedHost(
      place,
      scripted([
        () => showTurn("a", { kind: "diff", ref: "cs-1" }),
        (said) => showTurn("b", { kind: "file", ref: "src/a.ts" }, { from: settingIdIn(said) }),
        () => showTurn("c", { kind: "report", ref: "r1" }, { until: "2026-11-08T09:30:00Z" }),
        () => showTurn("d", { kind: "note", ref: "Reading the logs now." }, { until: "rests" }),
        () => textTurn("Set out the fix."),
        () => showTurn("e", { kind: "diff", ref: "cs-1" }),
        () => textTurn("The diff moved."),
      ]),
      new FakeClock(t0),
    );
    await before.json("/creatures", { name: "Pip" });
    const { conversation } = await before.json<{ conversation: string }>("/creatures/pip");
    await before.turn(conversation, "walk me through the fix");
    await before.until(async () => (await before.shown()).length === 3);
    const [diff, file, report] = await before.shown();
    await before.json(`/show/${file?.id}/answer`, { outcome: "pinned" });
    await before.turn(conversation, "the diff changed");
    const { setting: opened } = await before.json<{ setting: Setting }>("/show", {
      what: { kind: "url", ref: "https://example.com/ci" },
      from: file?.id,
    });
    const out = await before.shown();
    await before.stop();

    const after = await startedHost(
      place,
      scripted([() => showTurn("f", { kind: "note", ref: "One more." }), () => textTurn("Later.")]),
      new FakeClock(t0 + 40 * minuteMs),
    );
    const back = await after.shown();
    await after.turn(conversation, "anything else?");

    const again = out[2];
    expect(out.map(({ id }) => id)).toEqual([file?.id, report?.id, again?.id, opened.id]);
    expect(back).toEqual([out[0], out[2], out[3]]);
    expect(
      back.map(({ id, state, from, origin, replaces }) => [id, state, from, origin, replaces]),
    ).toEqual([
      [file?.id, "pinned", diff?.id, "creature", null],
      [again?.id, "live", null, "creature", diff?.id],
      [opened.id, "live", file?.id, "keeper", null],
    ]);
    expect(after.provider.heard.at(-1)).toBe(
      `Not set out: pip has set out ${hourlyLimit} settings this hour, the most a creature may set out; try again later.`,
    );
    expect(await after.shown()).toEqual(back);
    expect(after.showEvents()).toEqual([]);
    expect(keptSettingsIn(place)).toEqual(back);
    expect([...before.notices, ...after.notices]).toEqual([]);
    await after.stop();
  });

  it("drop without a word, after a crash, a rests setting and the live settings of a thread that is gone", async () => {
    const place = await workspacePlace();
    const reading = deferred();
    const before = await startedHost(
      place,
      scripted([
        () => showTurn("a", { kind: "note", ref: "Kept for you." }),
        () => showTurn("b", { kind: "diff", ref: "cs-2" }),
        () => textTurn("Set out."),
        () => showTurn("c", { kind: "note", ref: "Reading the logs now." }, { until: "rests" }),
        () => showTurn("d", { kind: "file", ref: "src/b.ts" }),
        async () => {
          await reading.promise;
          return textTurn("Read them.");
        },
      ]),
      new FakeClock(t0),
    );
    const gone = (await before.host.create()).id;
    await before.turn(gone, "set out the diff");
    const pinned = (await before.shown())[1];
    await before.json(`/show/${pinned?.id}/answer`, { outcome: "pinned" });
    const working = (await before.host.create()).id;
    await before.host.prompt(working, "read the logs");
    await before.until(async () => (await before.shown()).length === 4);
    const atTheCrash = await readFile(workspaceSettingsFile(place), "utf8");
    const out = await before.shown();
    reading.resolve();
    await before.settled(working);
    await before.stop();
    await writeFile(workspaceSettingsFile(place), atTheCrash);
    await rm((await findSession(place.sessionDir, gone))?.file ?? "missing session file");

    const after = await startedHost(place, scripted([]), new FakeClock(t0 + minuteMs));

    expect(out.map(({ sessionId, state, until }) => [sessionId, state, until])).toEqual([
      [gone, "live", "seen"],
      [gone, "pinned", "seen"],
      [working, "live", "rests"],
      [working, "live", "seen"],
    ]);
    expect(await after.shown()).toEqual([out[1], out[3]]);
    expect(keptSettingsIn(place)).toEqual([out[1], out[3]]);
    expect(after.showEvents()).toEqual([]);
    await after.stop();
  });

  it("start with none and say so once when the kept file is unreadable, and keep serving", async () => {
    const place = await workspacePlace();
    await mkdir(join(workspaceSettingsFile(place), ".."), { recursive: true });
    await writeFile(workspaceSettingsFile(place), "{ half a reco");

    const host = await startedHost(place, scripted([]), new FakeClock(t0));
    const session = (await host.host.create()).id;
    const { setting } = await host.json<{ setting: Setting }>("/show", {
      what: { kind: "file", ref: "README.md" },
      from: session,
    });

    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]).toMatch(/^keywork serve: the settings kept at .+ are unreadable \(/);
    expect(await readFile(`${workspaceSettingsFile(place)}.unreadable`, "utf8")).toBe(
      "{ half a reco",
    );
    expect(keptSettingsIn(place)).toEqual([setting]);
    await host.stop();
  });

  it("stay out across a re-trust, in the one store the workspace keeps, and across the next serve", async () => {
    const place = await workspacePlace();
    const untrusted = await serving(place, false);
    const session = await untrusted.json<{ id: string }>("/sessions", {});
    const { setting } = await untrusted.json<{ setting: Setting }>("/show", {
      what: { kind: "file", ref: "README.md" },
      from: session.id,
    });

    expect(await untrusted.json("/workspace/trust", {})).toMatchObject({ recomposed: true });
    expect(await untrusted.shown()).toEqual([setting]);
    expect(await untrusted.json(`/show/${setting.id}/answer`, { outcome: "pinned" })).toEqual({
      setting: { ...setting, state: "pinned" },
    });
    await untrusted.stop();
    const trusted = await serving(place, true);

    expect(await trusted.shown()).toEqual([{ ...setting, state: "pinned" }]);
    expect([...untrusted.errors, ...trusted.errors]).toEqual([]);
    await trusted.stop();
  });

  it("are one store for both hosts of a re-trust, which find each other's live threads, and outlive the host that closes", async () => {
    const place = await workspacePlace();
    const log = new EventLog();
    const clock = new FakeClock(t0);
    const shared = await servedSettings({
      log,
      file: workspaceSettingsFile(place),
      sessionDir: place.sessionDir,
      notice: () => undefined,
      clock,
    });
    const options = { ...place, provider: new MockProvider([]), log, settings: shared };
    const outgoing = await servedHost({
      ...options,
      projectTrusted: false,
      permissions: () => "allow",
    });
    const incoming = await servedHost({
      ...options,
      projectTrusted: true,
      permissions: () => "allow",
    });
    const liveInOutgoing = (await outgoing.create()).id;

    const opened = await incoming.show?.keeperOpens({
      what: { kind: "file", ref: "README.md" },
      from: liveInOutgoing,
      rung: "unfold",
    });
    if (opened === undefined || "refused" in opened) throw new Error("the keeper's opening failed");
    const timed = shared.settings.propose({
      creature: null,
      sessionId: liveInOutgoing,
      what: { kind: "note", ref: "Back in ten minutes." },
      rung: "card",
      why: "You asked to be reminded.",
      until: "2026-11-08T09:10:00Z",
      from: null,
      origin: "creature",
    });
    await outgoing.close();
    const pinned = incoming.show?.answer(opened.setting.id, "pinned");
    await clock.advanceTo(t0 + 11 * minuteMs, async () => undefined);

    expect(incoming.show).toBe(outgoing.show);
    expect(opened.setting.sessionId).toBe(liveInOutgoing);
    expect(timed).toMatchObject({ setting: { state: "live" } });
    expect(pinned).toEqual({ ...opened.setting, state: "pinned" });
    expect(incoming.show?.open()).toEqual([pinned]);
    expect(keptSettingsIn(place)).toEqual([pinned]);
    await incoming.close();
    shared.close();
  });

  it("tell the session that set something out, once, what the keeper did with it, and put nothing new on the wire", async () => {
    const place = await workspacePlace();
    const host = await startedHost(
      place,
      scripted([
        () => showTurn("a", { kind: "diff", ref: "cs-1" }, { rung: "unfold", size: "working" }),
        () => textTurn("Set out."),
        () => textTurn("Noted."),
        () => textTurn("Later."),
      ]),
      new FakeClock(t0),
    );
    const session = (await host.host.create()).id;
    await host.turn(session, "show me the diff");
    const [diff] = await host.shown();
    await host.json(`/show/${diff?.id}/answer`, { outcome: "pinned" });

    await host.turn(session, "what next?");
    await host.turn(session, "and after that?");

    const { requests } = host.provider;
    expect(diff).toMatchObject({ rung: "unfold", size: "working" });
    expect(textOf(requests[2]?.messages.at(-1))).toContain(
      `- ${diff?.id} (diff "cs-1"): the keeper pinned it; it stays out`,
    );
    expect(requests[2]?.messages.at(-1)?.parts.at(-1)).toEqual({
      type: "text",
      text: "what next?",
    });
    expect(notesIn(requests[3]?.messages ?? [])).toHaveLength(1);
    expect(requests[3]?.messages.slice(0, requests[2]?.messages.length)).toEqual(
      requests[2]?.messages,
    );
    expect(new Set(requests.map(({ systemPrompt }) => systemPrompt)).size).toBe(1);
    expect(requests[0]?.systemPrompt).toContain(yardPrompt);
    expect(host.showEvents().map(({ type }) => type)).toEqual(["show.proposed", "show.settled"]);
    const stored = await findSession(place.sessionDir, session);
    expect(stored?.messages().map(messageText).join(" ")).not.toContain("From the yard");
    const view = await host.json<{ messages: Message[] }>(`/sessions/${session}`);
    expect(view.messages.map(messageText).join(" ")).not.toContain("From the yard");
    await host.stop();
  });

  it("are listed and taken back by the model that set them out, as the creature on the wire", async () => {
    const place = await workspacePlace();
    const host = await startedHost(
      place,
      scripted([
        () => showTurn("a", { kind: "note", ref: "Reading the logs." }, { size: "readable" }),
        () => toolCallTurn({ type: "tool-call", callId: "b", name: "shown", arguments: {} }),
        (said) => withdrawTurn("c", settingIdInListing(said)),
        () => textTurn("Cleared."),
      ]),
      new FakeClock(t0),
    );
    const session = (await host.host.create()).id;

    await host.turn(session, "set out a note then take it back");

    const shownAnswer = host.provider.heard[2] ?? "";
    expect(shownAnswer.split("\n")[0]).toBe(
      "1 setting is out beside this conversation, oldest first, one JSON object to a line:",
    );
    expect(JSON.parse(shownAnswer.split("\n")[1] ?? "")).toMatchObject({
      what: { kind: "note", ref: "Reading the logs." },
      size: "readable",
      origin: "creature",
    });
    expect(host.provider.heard[3]).toMatch(/^Withdrawn: \S+ has left the yard/);
    expect(await host.shown()).toEqual([]);
    expect(keptSettingsIn(place)).toEqual([]);
    expect(host.showEvents().at(-1)?.payload).toMatchObject({
      outcome: "withdrawn",
      by: "creature",
    });
    await host.stop();
  });

  it("are kept in the same place by a host composed on its own", async () => {
    const place = await workspacePlace();
    const log = new EventLog();
    const options = { ...place, projectTrusted: true, provider: new MockProvider([]), log };
    const first = await servedHost({ ...options, permissions: () => undefined });
    const session = (await first.create()).id;
    const opened = await first.show?.keeperOpens({
      what: { kind: "file", ref: "README.md" },
      from: session,
      rung: "unfold",
    });
    if (opened === undefined || "refused" in opened) throw new Error("the keeper's opening failed");
    first.show?.answer(opened.setting.id, "pinned");
    await first.close();

    const second = await servedHost({ ...options, permissions: () => undefined });

    expect(second.show?.open()).toEqual([{ ...opened.setting, state: "pinned" }]);
    expect(existsSync(workspaceSettingsFile(place))).toBe(true);
    await second.close();
  });
});

interface Place {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

async function workspacePlace(): Promise<Place> {
  const cwd = await scratch();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "kept" }));
  return { cwd, sessionDir: await scratch(), userRoot: await scratch() };
}

function keptSettingsIn(place: Place): readonly Setting[] {
  const text = readFileSync(workspaceSettingsFile(place), "utf8");
  return (JSON.parse(text) as { settings: Setting[] }).settings;
}

async function startedHost(place: Place, provider: Scripted, clock: FakeClock) {
  const log = new EventLog();
  const notices: string[] = [];
  const settings = await servedSettings({
    log,
    file: workspaceSettingsFile(place),
    sessionDir: place.sessionDir,
    notice: (line) => notices.push(`keywork serve: ${line}`),
    clock,
    hourlyLimit,
  });
  const host = await servedHost({
    ...place,
    projectTrusted: true,
    provider,
    permissions: () => undefined,
    checkpoints: "off",
    log,
    settings,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const json = async <Shape>(path: string, body?: unknown): Promise<Shape> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, requestInit(token, body)),
    );
    expect(response.status, path).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  const until = async (done: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + waitLimitMs;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error("the host never got there");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const settled = (id: string) =>
    until(async () => (await host.list()).some((row) => row.id === id && !row.working));
  return {
    host,
    provider,
    notices,
    json,
    until,
    settled,
    shown: async () => (await json<{ settings: Setting[] }>("/show")).settings,
    turn: async (id: string, text: string) => {
      await host.prompt(id, text);
      await settled(id);
    },
    showEvents: () => log.since(0).filter(({ type }) => type.startsWith("show.")),
    stop: async () => {
      await server.close();
      settings.close();
    },
  };
}

async function serving(place: Place, projectTrusted: boolean) {
  const out: string[] = [];
  const errors: string[] = [];
  const stop = new AbortController();
  const finished = serve({
    ...place,
    projectTrusted,
    provider: new MockProvider([]),
    permissions: () => "allow",
    port: 0,
    ticketFile: join(await scratch(), "server.json"),
    signal: stop.signal,
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
  });
  const deadline = Date.now() + waitLimitMs;
  while (out.length < 3) {
    if (Date.now() > deadline) throw new Error(`keywork serve never listened: ${errors.join(" ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const url = out[0]?.replace("listening on ", "") ?? "";
  const served = out[1]?.replace("token ", "") ?? "";
  const json = async <Shape>(path: string, body?: unknown): Promise<Shape> => {
    const response = await fetch(`${url}${path}`, requestInit(served, body));
    expect(response.status, path).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  return {
    errors,
    json,
    shown: async () => (await json<{ settings: Setting[] }>("/show")).settings,
    stop: async () => {
      stop.abort();
      expect(await finished).toBe(0);
    },
  };
}

function requestInit(bearer: string, body: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
}

const waitLimitMs = 5_000;

interface Scripted extends Provider {
  readonly heard: string[];
  readonly requests: ProviderRequest[];
}

type ScriptedTurn = (said: string) => TurnDelta[] | Promise<TurnDelta[]>;

function scripted(turns: readonly ScriptedTurn[]): Scripted {
  const queue = [...turns];
  const heard: string[] = [];
  const requests: ProviderRequest[] = [];
  return {
    name: "scripted",
    heard,
    requests,
    async *stream(request) {
      requests.push(request);
      const said = lastToolResultIn(request.messages);
      heard.push(said);
      const turn = queue.shift();
      if (turn === undefined) throw new Error("the script ran out of turns");
      yield* await turn(said);
    },
  };
}

function lastToolResultIn(messages: readonly Message[]): string {
  const results = messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool-result" ? [part.output] : [])),
  );
  return results.at(-1) ?? "";
}

function textOf(message: Message | undefined): string {
  return message === undefined ? "" : messageText(message);
}

function notesIn(messages: readonly Message[]): readonly Message[] {
  return messages.filter((message) => messageText(message).includes("From the yard"));
}

function settingIdIn(said: string): string {
  return /name (\S+) as from\./.exec(said)?.[1] ?? `no setting id in: ${said}`;
}

function settingIdInListing(said: string): string {
  const row = JSON.parse(said.split("\n")[1] ?? "{}") as { id?: string };
  return row.id ?? `no setting id in: ${said}`;
}

function withdrawTurn(callId: string, id: string) {
  return toolCallTurn({ type: "tool-call", callId, name: "withdraw", arguments: { id } });
}

function showTurn(
  callId: string,
  what: { kind: string; ref: string },
  more: { until?: string; from?: string; rung?: string; size?: string } = {},
) {
  return toolCallTurn({
    type: "tool-call",
    callId,
    name: "show",
    arguments: { what, why: "The keeper asked for it.", ...more },
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
