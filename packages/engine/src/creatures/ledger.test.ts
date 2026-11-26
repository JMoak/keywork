import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { RunRow } from "../routines/run.ts";
import type { NeedsYouItem } from "../routines/service.ts";
import { creatureHost } from "./host.ts";
import {
  type ChoreFacts,
  type CreatureLedgerChange,
  type CreatureLedgerEntry,
  type CreatureLedgerOptions,
  creatureLedger,
  ledgerFileIn,
} from "./ledger.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-ledger-");

const first = new Date("2026-11-22T09:00:00.000Z");

const home = "C:/work/home";

async function stead(overrides: Partial<CreatureLedgerOptions> = {}) {
  const root = await scratch();
  const registry = new CreatureRegistry({ root, trusted: true, keeper: "Jordan", seed: () => 7 });
  const host = creatureHost({ registry, sessions: new FakeCreatureSessions() });
  for (const name of ["Ada", "Pip"]) await host.create({ name });
  let clock = first.getTime();
  const notices: string[] = [];
  const chores = new Map<string, ChoreFacts>();
  const options: CreatureLedgerOptions = {
    file: ledgerFileIn(join(root, "state")),
    creatures: host,
    exists: async (slug) => (await registry.read(slug)) !== undefined,
    chore: async (creature, routineId) => chores.get(`${creature}/${routineId}`),
    notice: (line) => notices.push(line),
    now: () => new Date(clock),
    ...overrides,
  };
  const open = () => {
    const ledger = creatureLedger(options);
    const heard: CreatureLedgerChange[] = [];
    ledger.subscribe((change) => heard.push(change));
    return { ledger, heard };
  };
  return {
    host,
    file: options.file,
    notices,
    chores,
    open,
    later: (minutes: number) => {
      clock += minutes * 60_000;
    },
  };
}

const pushAsk = {
  creature: "pip",
  session: "conv-1",
  parent: null,
  directory: home,
  callId: "c1",
  tool: "bash",
  arguments: { command: "git push origin main" },
};

function choreThread(runId: string, title = "Morning triage") {
  return {
    creature: "pip",
    session: `thread-${runId}`,
    directory: home,
    title,
    about: { kind: "chore" as const, routineId: "triage", runId },
  };
}

function endedRun(runId: string, ending: Partial<RunRow> = {}): RunRow {
  return {
    runId,
    creature: "pip",
    routineId: "triage",
    attempt: 1,
    trigger: "manual",
    catchUp: false,
    firedAt: "2026-11-22T09:00:00.000Z",
    scheduledFor: "2026-11-22T09:00:00.000Z",
    status: "ended",
    sessionId: `thread-${runId}`,
    startedAt: "2026-11-22T09:00:00.000Z",
    endedAt: "2026-11-22T09:04:00.000Z",
    process: "completed",
    delivery: "delivered",
    verified: null,
    reason: null,
    usage: null,
    cost: null,
    output: null,
    notify: null,
    ...ending,
  };
}

function grantsItem(routineId = "triage"): NeedsYouItem {
  return {
    creature: "pip",
    routineId,
    kind: "grants",
    reason: "accept the write grant set abc",
    runId: null,
    since: null,
    action: { verb: "accept", digest: "abc" },
  };
}

async function entriesOf(ledger: ReturnType<typeof creatureLedger>, creature = "pip") {
  return (await ledger.read(creature))?.entries ?? [];
}

describe("a question for the keeper", () => {
  it("waits from the moment a permission ask joins the queue, in plain words, until it is answered", async () => {
    const { open, later } = await stead();
    const { ledger, heard } = open();
    ledger.asked(pushAsk);

    const waiting: CreatureLedgerEntry = {
      id: expect.any(String),
      kind: "question",
      state: "waiting",
      title: "Allow bash git push origin main?",
      directory: home,
      session: "conv-1",
      openedAt: "2026-11-22T09:00:00.000Z",
      closedAt: null,
      answer: null,
      about: { kind: "ask", callId: "c1", tool: "bash" },
      conversation: null,
      project: null,
    };
    expect(await ledger.read("pip")).toEqual({ creature: "pip", entries: [waiting], folded: 0 });

    later(2);
    ledger.askSettled("conv-1", "c1", "granted");
    const answered = { ...waiting, state: "answered", closedAt: "2026-11-22T09:02:00.000Z" };
    expect(await entriesOf(ledger)).toEqual([{ ...answered, answer: "granted" }]);
    expect(heard).toEqual([
      { creature: "pip", change: "opened", entry: waiting, folded: 0 },
      { creature: "pip", change: "changed", entry: { ...answered, answer: "granted" }, folded: 0 },
    ]);
  });

  it("closes as lapsed when nobody answers, and hears one ask only once", async () => {
    const { open } = await stead();
    const { ledger } = open();
    ledger.asked(pushAsk);
    ledger.asked(pushAsk);
    ledger.askSettled("other-session", "c1", "denied");
    expect(await entriesOf(ledger)).toEqual([expect.objectContaining({ state: "waiting" })]);
    ledger.askSettled("conv-1", "c1", "lapsed");
    ledger.askSettled("conv-1", "c1", "granted");
    expect(await entriesOf(ledger)).toEqual([
      expect.objectContaining({ state: "answered", answer: "lapsed" }),
    ]);
  });

  it("waits while a chore is held on its grant set, and is granted once the keeper accepts", async () => {
    const { open, chores, later } = await stead();
    const { ledger } = open();
    chores.set("pip/triage", {
      title: "Morning triage",
      posture: "write",
      accepted: false,
      directory: home,
    });
    await ledger.choreNeeds({ creature: "pip", routineId: "triage", items: [grantsItem()] });
    await ledger.choreNeeds({ creature: "pip", routineId: "triage", items: [grantsItem()] });

    const held = {
      kind: "question",
      state: "waiting",
      title: 'May the chore "Morning triage" write?',
      directory: home,
      session: null,
      closedAt: null,
      answer: null,
      about: { kind: "grants", routineId: "triage" },
      conversation: null,
    };
    expect(await entriesOf(ledger)).toEqual([expect.objectContaining(held)]);

    later(3);
    chores.set("pip/triage", { ...(chores.get("pip/triage") as ChoreFacts), accepted: true });
    await ledger.choreNeeds({ creature: "pip", routineId: "triage", items: [] });
    expect(await entriesOf(ledger)).toEqual([
      expect.objectContaining({
        ...held,
        state: "answered",
        answer: "granted",
        closedAt: "2026-11-22T09:03:00.000Z",
      }),
    ]);
  });

  it("lapses a grants question when the chore stops needing it without an acceptance", async () => {
    const { open, chores } = await stead();
    const { ledger } = open();
    chores.set("pip/triage", { title: "Triage", posture: "act", accepted: false, directory: home });
    await ledger.choreNeeds({ creature: "pip", routineId: "triage", items: [grantsItem()] });
    expect((await entriesOf(ledger))[0]?.title).toBe('May the chore "Triage" act?');
    chores.delete("pip/triage");
    await ledger.choreNeeds({ creature: "pip", routineId: "triage", items: [] });
    expect(await entriesOf(ledger)).toEqual([
      expect.objectContaining({ state: "answered", answer: "lapsed" }),
    ]);
  });

  it("reads the chores held on grants once at start, opening the missing questions and closing stale ones", async () => {
    const { open, chores } = await stead();
    const { ledger } = open();
    for (const routineId of ["triage", "digest"]) {
      chores.set(`pip/${routineId}`, {
        title: routineId,
        posture: "write",
        accepted: false,
        directory: home,
      });
    }
    await ledger.choreNeeds({
      creature: "pip",
      routineId: "digest",
      items: [grantsItem("digest")],
    });
    chores.set("pip/digest", { ...(chores.get("pip/digest") as ChoreFacts), accepted: true });

    const run: NeedsYouItem = { ...grantsItem(), kind: "run", action: null };
    await ledger.choresNeeding([grantsItem("triage"), run]);

    const questions = await entriesOf(ledger);
    expect(questions.map(({ state, answer, about }) => ({ state, answer, about }))).toEqual([
      { state: "waiting", answer: null, about: { kind: "grants", routineId: "triage" } },
      { state: "answered", answer: "granted", about: { kind: "grants", routineId: "digest" } },
    ]);
  });
});

describe("a task", () => {
  it("runs from its chore thread's opening, finishes with its run, and is done once the keeper looks", async () => {
    const { open, later } = await stead();
    const { ledger, heard } = open();
    ledger.threadOpened(choreThread("r1"));
    ledger.threadOpened(choreThread("r1"));
    const running: CreatureLedgerEntry = {
      id: expect.any(String),
      kind: "task",
      state: "running",
      title: "Morning triage",
      directory: home,
      session: "thread-r1",
      openedAt: "2026-11-22T09:00:00.000Z",
      closedAt: null,
      answer: null,
      about: { kind: "chore", routineId: "triage", runId: "r1" },
      conversation: null,
      project: null,
    };
    expect(await entriesOf(ledger)).toEqual([running]);
    const id = (await entriesOf(ledger))[0]?.id ?? "";
    expect(await ledger.seen("pip", id)).toBe("not-finished");

    later(10);
    ledger.choreFinished(endedRun("r1"));
    const finished = { ...running, state: "finished", closedAt: "2026-11-22T09:04:00.000Z" };
    expect(await entriesOf(ledger)).toEqual([finished]);

    expect(await ledger.seen("pip", id)).toEqual({ ...finished, state: "done" });
    expect(await ledger.seen("pip", id)).toEqual({ ...finished, state: "done" });
    expect(heard.map(({ change, entry }) => [change, entry.state])).toEqual([
      ["opened", "running"],
      ["changed", "finished"],
      ["changed", "done"],
    ]);
    expect(await ledger.seen("pip", "no-such-entry")).toBe("missing-entry");
    expect(await ledger.seen("nobody", id)).toBe("missing-creature");
    expect(await ledger.read("nobody")).toBeUndefined();
  });

  it("is blocked when its run failed, timed out, ran over budget or could not deliver", async () => {
    const { open } = await stead();
    const { ledger } = open();
    const endings: Partial<RunRow>[] = [
      { process: "failed" },
      { process: "timed-out" },
      { process: "blocked" },
      { delivery: "failed" },
      { process: "cancelled", delivery: "none" },
    ];
    endings.forEach((ending, index) => {
      ledger.threadOpened(choreThread(`r${index}`));
      ledger.choreFinished(endedRun(`r${index}`, ending));
    });
    const states = (await entriesOf(ledger)).map(({ state, about }) => [
      about.kind === "chore" ? about.runId : "",
      state,
    ]);
    expect(Object.fromEntries(states)).toEqual({
      r0: "blocked",
      r1: "blocked",
      r2: "blocked",
      r3: "blocked",
      r4: "finished",
    });
    const blocked = (await entriesOf(ledger)).find((entry) => entry.state === "blocked");
    expect(await ledger.seen("pip", blocked?.id ?? "")).toBe("not-finished");
  });

  it("takes a thread's title and ending from its report", async () => {
    const { open } = await stead();
    const { ledger } = open();
    ledger.threadOpened({
      creature: "ada",
      session: "t1",
      directory: home,
      title: "untitled thread",
      about: { kind: "thread" },
    });
    ledger.threadReported("t1", { title: "Sort the inbox", outcome: "blocked", summary: "" });
    ledger.threadReported("t1", { title: "Later", outcome: "completed", summary: "" });
    expect(await entriesOf(ledger, "ada")).toEqual([
      expect.objectContaining({ title: "Sort the inbox", state: "blocked", session: "t1" }),
    ]);
  });
});

describe("the ledger's order and bound", () => {
  it("lists waiting questions first, then running tasks, then closed entries, each newest first", async () => {
    const { open, later } = await stead();
    const { ledger } = open();
    ledger.threadOpened(choreThread("old"));
    later(1);
    ledger.asked({ ...pushAsk, callId: "early" });
    later(1);
    ledger.threadOpened(choreThread("new"));
    later(1);
    ledger.asked({ ...pushAsk, callId: "late" });
    later(1);
    ledger.asked({ ...pushAsk, callId: "answered" });
    ledger.askSettled("conv-1", "answered", "denied");
    ledger.choreFinished(endedRun("old", { endedAt: "2026-11-22T09:05:00.000Z" }));

    const order = (await entriesOf(ledger)).map(({ state, about }) =>
      about.kind === "ask" ? `${state} ${about.callId}` : `${state} ${about.kind}`,
    );
    expect(order).toEqual([
      "waiting late",
      "waiting early",
      "running chore",
      "finished chore",
      "answered answered",
    ]);
  });

  it("keeps the most recent closed entries, folds older ones into a count, and always keeps open ones", async () => {
    const { open, later } = await stead({ keepsClosed: 2 });
    const { ledger, heard } = open();
    ledger.asked({ ...pushAsk, callId: "still-waiting" });
    for (const callId of ["a", "b", "c", "d"]) {
      later(1);
      ledger.asked({ ...pushAsk, callId });
      ledger.askSettled("conv-1", callId, "granted");
    }
    const view = await ledger.read("pip");
    expect(view?.folded).toBe(2);
    expect(
      view?.entries.map(({ about }) => (about.kind === "ask" ? about.callId : about.kind)),
    ).toEqual(["still-waiting", "d", "c"]);
    expect(
      heard
        .filter(({ change }) => change === "folded")
        .map(({ entry, folded }) => [entry.about.kind === "ask" && entry.about.callId, folded]),
    ).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});

describe("the ledger on disk", () => {
  it("outlives a restart, settling what no restart can keep: a waiting ask lapses and a running task is blocked", async () => {
    const { open, chores, later, file } = await stead({ keepsClosed: 2 });
    const before = open().ledger;
    chores.set("pip/triage", {
      title: "Morning triage",
      posture: "write",
      accepted: false,
      directory: home,
    });
    await before.choreNeeds({ creature: "pip", routineId: "triage", items: [grantsItem()] });
    before.asked(pushAsk);
    before.threadOpened(choreThread("r1"));
    before.threadOpened(choreThread("r0"));
    before.choreFinished(endedRun("r0", { endedAt: "2026-11-22T08:59:00.000Z" }));
    const kept = await before.read("pip");
    before.close();

    later(30);
    const { ledger: after, heard } = open();
    const restarted = await after.read("pip");
    const cutOff = "2026-11-22T09:30:00.000Z";
    expect(restarted?.folded).toBe(1);
    const [held, ...cutOffEntries] = restarted?.entries ?? [];
    expect(held).toMatchObject({ state: "waiting", closedAt: null, about: { kind: "grants" } });
    expect(cutOffEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "answered",
          answer: "lapsed",
          closedAt: cutOff,
          about: expect.objectContaining({ kind: "ask" }),
        }),
        expect.objectContaining({
          state: "blocked",
          answer: null,
          closedAt: cutOff,
          about: expect.objectContaining({ kind: "chore", runId: "r1" }),
        }),
      ]),
    );
    expect(cutOffEntries).toHaveLength(2);
    expect(kept?.entries.map(({ id }) => id)).toEqual(
      expect.arrayContaining(restarted?.entries.map(({ id }) => id) ?? []),
    );
    expect(heard).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 1,
      creatures: { pip: { folded: 1 } },
    });
  });

  it("forgets a session while it is in the trash, and names it again once it is restored", async () => {
    const { open } = await stead();
    const { ledger } = open();
    ledger.asked({ ...pushAsk, session: "child-1", parent: "conv-1", callId: "c2" });
    ledger.threadOpened(choreThread("r1"));
    ledger.sessionRemoved("conv-1");
    ledger.sessionRemoved("thread-r1");
    expect((await entriesOf(ledger)).map(({ session }) => session)).toEqual([null, null]);
    ledger.sessionRestored("conv-1");
    ledger.sessionRestored("thread-r1");
    expect((await entriesOf(ledger)).map(({ session }) => session)).toEqual([
      "child-1",
      "thread-r1",
    ]);
  });

  it("drops a removed creature's ledger, so one made again under its slug starts from none", async () => {
    const { host, open } = await stead();
    const { ledger } = open();
    ledger.asked(pushAsk);
    ledger.asked({ ...pushAsk, creature: "ada", session: "ada-conv" });
    await host.remove("pip");
    expect(await ledger.read("pip")).toBeUndefined();
    ledger.close();

    await host.create({ name: "Pip" });
    const again = open().ledger;
    expect(await again.read("pip")).toEqual({ creature: "pip", entries: [], folded: 0 });
    expect(await entriesOf(again, "ada")).toHaveLength(1);
  });

  it("starts empty over an unreadable ledger and sets it aside, saying where", async () => {
    const { open, file, notices } = await stead();
    open().ledger.asked(pushAsk);
    await writeFile(file, '{"version":1,"creatures":{"pip":{"entries":[{"id":""}],"folded":0}}}');

    const { ledger } = open();

    expect(await entriesOf(ledger)).toEqual([]);
    expect(existsSync(`${file}.unreadable`)).toBe(true);
    expect(notices).toEqual([expect.stringMatching(/unreadable .*starts empty.*moved to/)]);
  });
});
