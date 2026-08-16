import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CurationJudgmentPort } from "../gardener.ts";
import { ReviewInbox } from "../inbox.ts";
import { MemoryInertError, MemoryStore } from "../store.ts";
import {
  ArcAirlock,
  ArcStillActiveError,
  IneligibleDeliveryError,
  MissingSuccessorError,
  UndecidedItemsError,
  UnknownTriageTargetError,
  WedgedSessionsError,
} from "./airlock.ts";
import { ArcBindings } from "./bindings.ts";
import { ArcNotActiveError, ArcRegistry } from "./registry.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  workspace: MemoryStore;
  registry: ArcRegistry;
  bindings: ArcBindings;
  inbox: ReviewInbox;
  airlock: ArcAirlock;
  cited: Set<string>;
}

async function fixture(
  options: { trusted?: boolean; judgment?: CurationJudgmentPort } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "keywork-airlock-"));
  cleanups.push(root);
  const trusted = options.trusted ?? true;
  const now = () => new Date("2026-08-16T09:00:00.000Z");
  const secrets = { API_KEY: "hunter2secret" };
  const workspace = new MemoryStore({ vaultRoot: root, trusted, now, secrets });
  const registry = new ArcRegistry({ vaultRoot: root, trusted, now, secrets });
  const bindings = new ArcBindings();
  const inbox = new ReviewInbox({ filePath: join(root, ".staging", "inbox.json"), now });
  const cited = new Set<string>();
  const airlock = new ArcAirlock({
    registry,
    bindings,
    workspace,
    inbox,
    citedNotes: async () => [...cited],
    now,
    ...(options.judgment !== undefined && { judgment: options.judgment }),
  });
  return { root, workspace, registry, bindings, inbox, airlock, cited };
}

async function seededArc(f: Fixture, slug = "dock-v2"): Promise<void> {
  await f.registry.createArc(slug);
  await f.registry.arcStore(slug).writeNote({
    title: "Dock Ratio Finding",
    body: "Docks split 50/50 by default.\n",
    provenance: "agent",
  });
  f.cited.add("Dock Ratio Finding");
}

describe("the acknowledgement sweep", () => {
  it("flushes every bound session before the digest opens", async () => {
    const f = await fixture();
    await seededArc(f);
    f.bindings.bind("s1", "dock-v2");
    f.bindings.bind("s2", "dock-v2");
    const flushed: string[] = [];
    const digest = await f.airlock.prepareClose("dock-v2", {
      flushes: new Map([
        ["s1", async () => void flushed.push("s1")],
        ["s2", async () => void flushed.push("s2")],
      ]),
    });
    expect(flushed.sort()).toEqual(["s1", "s2"]);
    expect(digest.sweep).toEqual({ acked: ["s1", "s2"], wedged: [], forced: false });
  });

  it("refuses to close past a wedged session unless forced", async () => {
    const f = await fixture();
    await seededArc(f);
    f.bindings.bind("s1", "dock-v2");
    f.bindings.bind("s2", "dock-v2");
    const flushes = new Map([
      ["s1", async () => undefined],
      [
        "s2",
        async () => {
          throw new Error("session wedged");
        },
      ],
    ]);
    await expect(f.airlock.prepareClose("dock-v2", { flushes })).rejects.toThrow(
      WedgedSessionsError,
    );
    const digest = await f.airlock.prepareClose("dock-v2", { flushes, force: true });
    expect(digest.sweep).toEqual({ acked: ["s1"], wedged: ["s2"], forced: true });
  });
});

describe("the digest", () => {
  it("lists every candidate with its rubric verdict and opens the fourth inbox door", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.registry.arcStore("dock-v2").writeNote({
      title: "Uncited Hunch",
      body: "Maybe docks want thirds.\n",
      provenance: "agent",
    });
    await f.registry
      .openQuestions("dock-v2")
      .add({ title: "Tie order", body: "Who wins focus ties?", provenance: "user" });
    const digest = await f.airlock.prepareClose("dock-v2");
    const byName = new Map(digest.candidates.map((c) => [c.note.name, c]));
    expect(byName.get("Dock Ratio Finding")?.eligible).toBe(true);
    expect(byName.get("Uncited Hunch")?.shortfalls).toEqual(["uncited"]);
    expect(digest.candidates.map((c) => c.note.name)).not.toContain("MOC");
    expect(digest.questions.map((q) => q.title)).toEqual(["Tie order"]);
    const reloaded = new ReviewInbox({ filePath: join(f.root, ".staging", "inbox.json") });
    const keys = (await reloaded.list()).map((item) => item.key).sort();
    expect(keys).toEqual([
      "arc-distillation:dock-v2:dock ratio finding",
      "arc-distillation:dock-v2:uncited hunch",
      "arc-question:dock-v2:tie order",
    ]);
  });

  it("marks contradicted and superseded notes below the bar", async () => {
    const f = await fixture();
    await seededArc(f);
    const store = f.registry.arcStore("dock-v2");
    await store.writeNote({ title: "Old Rule", body: "Docks split 60/40.\n", provenance: "agent" });
    await store.writeNote({
      title: "New Rule",
      body: "Docks split 50/50.\n",
      provenance: "agent",
      supersedes: "Old Rule",
    });
    await f.inbox.add([
      {
        kind: "contradiction",
        a: "Dock Ratio Finding",
        b: "New Rule",
        aProvenance: "agent",
        bProvenance: "agent",
        confidence: 0.9,
      },
    ]);
    const digest = await f.airlock.prepareClose("dock-v2");
    const byName = new Map(digest.candidates.map((c) => [c.note.name, c]));
    expect(byName.get("Dock Ratio Finding")?.shortfalls).toEqual(["contradicted"]);
    expect(byName.get("Old Rule")?.shortfalls).toEqual(["uncited", "superseded"]);
  });

  it("shows what the open-question cap merged or dropped", async () => {
    const f = await fixture();
    await f.registry.createArc("dock-v2");
    const questions = f.registry.openQuestions("dock-v2");
    for (let i = 0; i < questions.cap; i += 1) {
      await questions.add({ title: `Q${i}`, body: "q", provenance: "user" });
    }
    await questions.add({ title: "Merged In", body: "extra", provenance: "user" }, { merge: "Q0" });
    await questions.add({ title: "After Drop", body: "new", provenance: "user" }, { drop: "Q1" });
    const digest = await f.airlock.prepareClose("dock-v2");
    expect(digest.capEvents.dropped).toEqual(["Q1"]);
    expect(digest.capEvents.absorbed).toEqual([{ into: "Q0", titles: ["Merged In"] }]);
  });
});

describe("completing the close", () => {
  it("runs the whole ritual: stamps, cover sheet, daily line, archive, release, drain, audit", async () => {
    const f = await fixture();
    await seededArc(f);
    f.bindings.bind("s1", "dock-v2");
    await f.airlock.prepareClose("dock-v2", { flushes: new Map([["s1", async () => undefined]]) });
    const delivery = await f.airlock.completeClose("dock-v2", {
      candidates: { "Dock Ratio Finding": "deliver" },
      questions: {},
    });
    expect(delivery.delivered).toEqual(["Dock Ratio Finding"]);
    const note = await f.workspace.readNote("Dock Ratio Finding");
    expect(note?.delivered).toBe("2026-08-16T09:00:00.000Z");
    expect(note?.distilledFrom).toBe("arcs/dock-v2/MOC");
    expect(note?.frontmatter.valid_from).toBe("2026-08-16T09:00:00.000Z");
    const record = await f.workspace.readNote("arc dock-v2 delivery");
    expect(record?.links).toContain("Dock Ratio Finding");
    expect(record?.links).toContain("arcs/dock-v2/MOC");
    expect(record?.delivered).toBe("2026-08-16T09:00:00.000Z");
    const daily = await f.workspace.readDaily("2026-08-16");
    expect(daily.map((entry) => entry.text)).toContain("arc dock-v2 delivered — distilled 1 notes");
    expect((await f.registry.readArc("dock-v2"))?.status).toBe("archived");
    expect(f.bindings.bindingOf("s1")).toBeUndefined();
    expect(await f.inbox.list()).toEqual([]);
    const audit = await readFile(join(f.root, "curation.md"), "utf8");
    expect(audit).toContain("arc dock-v2 closed: delivered 1");
  });

  it("closes an arc with zero notes calmly", async () => {
    const f = await fixture();
    await f.registry.createArc("empty-arc");
    const digest = await f.airlock.prepareClose("empty-arc");
    expect(digest.candidates).toEqual([]);
    const delivery = await f.airlock.completeClose("empty-arc", { candidates: {}, questions: {} });
    expect(delivery.delivered).toEqual([]);
    const record = await f.workspace.readNote("arc empty-arc delivery");
    expect(record?.body).toContain("distilled 0 notes");
    expect((await f.registry.readArc("empty-arc"))?.status).toBe("archived");
  });

  it("refuses a double close", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.airlock.completeClose("dock-v2", {
      candidates: { "Dock Ratio Finding": "deliver" },
      questions: {},
    });
    await expect(
      f.airlock.completeClose("dock-v2", { candidates: {}, questions: {} }),
    ).rejects.toThrow(ArcNotActiveError);
    await expect(f.airlock.prepareClose("dock-v2")).rejects.toThrow(ArcNotActiveError);
  });

  it("triages nothing implicitly: every undecided item blocks the close", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.registry
      .openQuestions("dock-v2")
      .add({ title: "Tie order", body: "?", provenance: "user" });
    await expect(
      f.airlock.completeClose("dock-v2", { candidates: {}, questions: {} }),
    ).rejects.toThrow(UndecidedItemsError);
    await expect(
      f.airlock.completeClose("dock-v2", {
        candidates: { "Dock Ratio Finding": "leave", Ghost: "deliver" },
        questions: { "Tie order": "resolve" },
      }),
    ).rejects.toThrow(UnknownTriageTargetError);
    expect((await f.registry.readArc("dock-v2"))?.status).toBe("active");
  });

  it("keeps below-bar items behind the rubric", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.registry.arcStore("dock-v2").writeNote({
      title: "Uncited Hunch",
      body: "Maybe thirds.\n",
      provenance: "agent",
    });
    await expect(
      f.airlock.completeClose("dock-v2", {
        candidates: { "Dock Ratio Finding": "deliver", "Uncited Hunch": "deliver" },
        questions: {},
      }),
    ).rejects.toThrow(IneligibleDeliveryError);
    const delivery = await f.airlock.completeClose("dock-v2", {
      candidates: { "Dock Ratio Finding": "deliver", "Uncited Hunch": "leave" },
      questions: {},
    });
    expect(delivery.left).toEqual(["Uncited Hunch"]);
    expect(await f.workspace.readNote("Uncited Hunch")).toBeUndefined();
  });

  it("triages questions through all three doors and carries only by explicit choice", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.registry.createArc("dock-v3");
    const questions = f.registry.openQuestions("dock-v2");
    await questions.add({ title: "Resolved One", body: "done?", provenance: "user" });
    await questions.add({ title: "Carried One", body: "still open", provenance: "user" });
    await questions.add({ title: "Dropped One", body: "meh", provenance: "agent" });
    await expect(
      f.airlock.completeClose("dock-v2", {
        candidates: { "Dock Ratio Finding": "leave" },
        questions: { "Resolved One": "resolve", "Carried One": "carry", "Dropped One": "drop" },
      }),
    ).rejects.toThrow(MissingSuccessorError);
    await f.airlock.completeClose("dock-v2", {
      candidates: { "Dock Ratio Finding": "leave" },
      questions: { "Resolved One": "resolve", "Carried One": "carry", "Dropped One": "drop" },
      successor: "dock-v3",
    });
    const closed = await questions.list();
    const statusOf = new Map(closed.map((question) => [question.title, question.status]));
    expect(statusOf.get("Resolved One")).toBe("resolved");
    expect(statusOf.get("Carried One")).toBe("carried");
    expect(statusOf.get("Dropped One")).toBe("dropped");
    const carried = await f.registry.openQuestions("dock-v3").open();
    expect(carried.map((question) => question.title)).toEqual(["Carried One"]);
  });

  it("redacts secrets from anything the airlock persists, even hand-planted arc files", async () => {
    const f = await fixture();
    await f.registry.createArc("dock-v2");
    await mkdir(join(f.root, "arcs", "dock-v2"), { recursive: true });
    await writeFile(
      join(f.root, "arcs", "dock-v2", "Leaky Note.md"),
      "The deploy key is hunter2secret and sk-abcdef123456789 works too.\n",
      "utf8",
    );
    f.cited.add("Leaky Note");
    await f.airlock.completeClose("dock-v2", {
      candidates: { "Leaky Note": "deliver" },
      questions: {},
    });
    const raw = await readFile(join(f.root, "Leaky Note.md"), "utf8");
    expect(raw).not.toContain("hunter2secret");
    expect(raw).not.toContain("sk-abcdef123456789");
    expect(raw).toContain("‹redacted:API_KEY›");
  });
});

describe("stragglers and abandonment", () => {
  it("routes a crashed session's late staged items to the workspace inbox, never reopening the arc", async () => {
    const f = await fixture();
    await seededArc(f);
    await f.airlock.completeClose("dock-v2", {
      candidates: { "Dock Ratio Finding": "deliver" },
      questions: {},
    });
    const arcStore = f.registry.arcStore("dock-v2");
    await arcStore.writeNote({
      title: "Late Find",
      body: "surfaced late\n",
      provenance: "untrusted",
    });
    await arcStore.appendDaily("late daily fact", "untrusted");
    const routed = await f.airlock.routeStragglers("dock-v2");
    expect(routed).toHaveLength(2);
    expect(await arcStore.listStaged()).toEqual([]);
    const staged = await f.workspace.listStaged();
    expect(staged.map((item) => item.target).sort()).toEqual([
      "Late Find.md",
      "daily/2026-08-16.md",
    ]);
    expect((await f.registry.readArc("dock-v2"))?.status).toBe("archived");
  });

  it("only routes stragglers out of archived arcs", async () => {
    const f = await fixture();
    await seededArc(f);
    await expect(f.airlock.routeStragglers("dock-v2")).rejects.toThrow(ArcStillActiveError);
  });

  it("abandon archives without distilling and never deletes", async () => {
    const f = await fixture();
    await seededArc(f);
    f.bindings.bind("s1", "dock-v2");
    const arc = await f.airlock.abandon("dock-v2");
    expect(arc.status).toBe("archived");
    expect(arc.abandoned).toBe(true);
    expect(f.bindings.bindingOf("s1")).toBeUndefined();
    expect(await f.workspace.readNote("Dock Ratio Finding")).toBeUndefined();
    const kept = await readFile(join(f.root, "arcs", "dock-v2", "Dock Ratio Finding.md"), "utf8");
    expect(kept).toContain("Docks split 50/50");
    const audit = await readFile(join(f.root, "curation.md"), "utf8");
    expect(audit).toContain("arc dock-v2 abandoned");
  });
});

describe("distillation reuses the Gardener kernel", () => {
  it("promotes arc daily-log entries into candidates before the digest", async () => {
    const judgment: CurationJudgmentPort = {
      id: "stub",
      proposePromotions: async (entries) =>
        entries.map((entry) => ({
          entryId: entry.id,
          title: "Promoted Finding",
          body: entry.text,
          confidence: 0.95,
        })),
      classifyPair: async () => ({ relation: "distinct", confidence: 0 }),
    };
    const f = await fixture({ judgment });
    await f.registry.createArc("dock-v2");
    await f.registry.arcStore("dock-v2").appendDaily("dock chrome uses the theme ramp", "agent");
    const digest = await f.airlock.prepareClose("dock-v2");
    const promoted = digest.candidates.find((c) => c.note.name === "Promoted Finding");
    expect(promoted?.note.body).toContain("dock chrome uses the theme ramp");
  });
});

describe("untrusted workspaces", () => {
  it("keeps the airlock fully inert", async () => {
    const f = await fixture({ trusted: false });
    await expect(f.airlock.prepareClose("dock-v2")).rejects.toThrow(MemoryInertError);
    await expect(
      f.airlock.completeClose("dock-v2", { candidates: {}, questions: {} }),
    ).rejects.toThrow(MemoryInertError);
    await expect(f.airlock.abandon("dock-v2")).rejects.toThrow(MemoryInertError);
  });
});
