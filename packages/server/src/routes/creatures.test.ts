import {
  type CreatureChores,
  loadRatchet,
  MalformedCreatureError,
  MockProvider,
  RatchetUnreachableError,
  type RoutineService,
  ShadowReportUnserved,
  type WorkshopView,
} from "@keywork/engine";
import { InvalidSlugError } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { keeperLedgerPath } from "../../../engine/src/creatures/decisions/files.ts";
import {
  promotableClass,
  promotableNode,
  scratchNode,
} from "../../../engine/src/creatures/decisions/testing.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { operationOf, routes } from "../openapi.ts";
import { memorySessionHost } from "../testing.ts";
import {
  type CreatureDetail,
  type CreatureDraft,
  type CreaturePatch,
  type CreatureRemoval,
  type CreatureReport,
  type CreatureSummary,
  type CreaturesPort,
  creatureDraftOf,
  creatureFamily,
  creaturePatchOf,
  creatureRoutes,
  nameTakenOnNodeLine,
  type RemovalChoice,
  removalChoiceOf,
  ruleClassOf,
} from "./creatures.ts";
import type { RouteHandler, RouteParams } from "./family.ts";
import type { WorkshopsPort } from "./workshops.ts";

const origin = "http://127.0.0.1:4770";

const inherit = {
  strong: "inherit",
  loop: "inherit",
  decide: "inherit",
  vision: "inherit",
} as const;

const pip: CreatureSummary = {
  slug: "pip",
  name: "Pip",
  sigil: "P",
  created: "2026-11-05T09:00:00.000Z",
  skin: "tinkerer",
  seed: 7,
  workshop: "host",
  models: inherit,
  conversation: null,
  threads: 0,
  paused: null,
  inbound: "paired",
};

const pipReport: CreatureReport = {
  creature: "pip",
  gateId: "keeper.would-approve",
  mode: "shadow",
  enforced: false,
  ledgerPath: "C:/state/node/decisions/keeper-would-approve.jsonl",
  rows: 0,
  earlierRows: 0,
  classes: [],
};

const pipDetail: CreatureDetail = {
  ...pip,
  introduction: "You are Pip, Jordan's creature.",
  conversation: "s1",
  threads: [],
  nextRun: null,
  usage: { date: "2026-11-05", sessions: 1, costNanos: null },
  routines: "routines",
};

const pipRemoval: CreatureRemoval = {
  slug: "pip",
  goes: {
    definition: "C:/work/.keywork/bots/pip",
    conversation: "s1",
    threads: ["s2"],
    notes: 0,
    routines: 0,
    workshop: null,
  },
  stays: { workspace: "C:/work", workshop: null },
};

interface FakePort extends CreaturesPort {
  drafts: CreatureDraft[];
  patches: CreaturePatch[];
  chores: CreatureChores[];
  choices: Array<{ verb: "removal" | "remove"; slug: string; choice: RemovalChoice | undefined }>;
}

function fakePort(
  create: (draft: CreatureDraft) => Promise<CreatureSummary> = async () => pip,
  report: () => Promise<CreatureReport> = async () => pipReport,
) {
  const port: FakePort = {
    drafts: [],
    patches: [],
    chores: [],
    choices: [],
    update: async (slug, patch) => {
      port.patches.push(patch);
      if (patch.body?.skin === "refused") throw new MalformedCreatureError("creature.json", "no");
      return slug === "pip"
        ? { ...pip, ...(patch.name !== undefined && { name: patch.name }) }
        : undefined;
    },
    report: async (slug) => (slug === "pip" ? report() : undefined),
    pause: async (slug, chores) => {
      port.chores.push(chores);
      const ids = await chores.enabled(slug);
      return slug === "pip" ? { slug, paused: true, since: pip.created, chores: ids } : undefined;
    },
    resume: async (slug, chores) => {
      port.chores.push(chores);
      return slug === "pip" ? { slug, paused: false, since: null, chores: [] } : undefined;
    },
    list: async () => [pip],
    read: async (slug) => (slug === "pip" ? pipDetail : undefined),
    create: async (draft) => {
      port.drafts.push(draft);
      return create(draft);
    },
    removal: async (slug, choice) => {
      port.choices.push({ verb: "removal", slug, choice });
      return slug === "pip" ? pipRemoval : undefined;
    },
    remove: async (slug, choice) => {
      port.choices.push({ verb: "remove", slug, choice });
      return slug === "pip" ? pipRemoval : undefined;
    },
    subscribe: () => () => undefined,
  };
  return port;
}

function handlers(
  port?: CreaturesPort,
  extra: { workshops?: WorkshopsPort; routines?: RoutineService } = {},
) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = port === undefined ? base : { ...base, creatures: port, ...extra };
  return creatureFamily.handlers({
    host,
    log,
    streams: { add: () => () => undefined },
    describe: fixtureDocument,
  });
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

describe("the creature routes", () => {
  it("answer 503 on a host that serves no creatures", async () => {
    const h = handlers();
    expect((await call(h.listCreatures, "GET", "/creatures")).status).toBe(503);
    expect((await call(h.readCreature, "GET", "/creatures/pip", { slug: "pip" })).status).toBe(503);
    const created = await call(h.createCreature, "POST", "/creatures", {}, { name: "Pip" });
    expect(created).toEqual({
      status: 503,
      body: { error: "creatures is not served by this host" },
    });
  });

  it("list the creatures the port knows", async () => {
    const h = handlers(fakePort());
    expect(await call(h.listCreatures, "GET", "/creatures")).toEqual({
      status: 200,
      body: { creatures: [pip] },
    });
  });

  it("create from a draft, passing only what the body chose", async () => {
    const port = fakePort();
    const h = handlers(port);
    const draft = {
      name: "Pip",
      skin: "otter",
      models: { loop: { provider: "ollama", model: "qwen3:8b" }, decide: "inherit" },
    };
    expect(await call(h.createCreature, "POST", "/creatures", {}, draft)).toEqual({
      status: 201,
      body: pip,
    });
    expect(port.drafts).toEqual([draft]);
  });

  it.each([
    ["no name", {}],
    ["a blank name", { name: "  " }],
    ["a name past 64 characters", { name: "p".repeat(65) }],
    ["a skin that is not kebab-case", { name: "Pip", skin: "Big Cat" }],
    ["a blank workshop", { name: "Pip", workshop: "" }],
    ["an unknown model class", { name: "Pip", models: { fast: "inherit" } }],
    ["a model choice without a provider", { name: "Pip", models: { loop: { model: "x" } } }],
    ["a model reference as a string", { name: "Pip", models: { loop: "ollama/qwen3:8b" } }],
    ["an unknown key", { name: "Pip", pet: true }],
    ["no object at all", "Pip"],
  ])("refuse a body with %s", async (_what, body) => {
    const port = fakePort();
    const h = handlers(port);
    const answer = await call(h.createCreature, "POST", "/creatures", {}, body);
    expect(answer.status).toBe(400);
    expect(String(answer.body.error)).toMatch(/the body must be/);
    expect(port.drafts).toEqual([]);
  });

  it("map the port's refusals as the rest of the server does", async () => {
    const taken = handlers(
      fakePort(async () => {
        throw new Error("a bot named pip already exists (project)");
      }),
    );
    expect(await call(taken.createCreature, "POST", "/creatures", {}, { name: "Pip" })).toEqual({
      status: 409,
      body: { error: "a bot named pip already exists (project)" },
    });
    const noSlug = handlers(
      fakePort(async () => {
        throw new InvalidSlugError("creature", "", "use lowercase letters");
      }),
    );
    expect(
      (await call(noSlug.createCreature, "POST", "/creatures", {}, { name: "!!!" })).status,
    ).toBe(400);
  });

  it("read one creature and 404 an unknown slug", async () => {
    const h = handlers(fakePort());
    expect(await call(h.readCreature, "GET", "/creatures/pip", { slug: "pip" })).toEqual({
      status: 200,
      body: pipDetail,
    });
    expect(await call(h.readCreature, "GET", "/creatures/mo", { slug: "mo" })).toEqual({
      status: 404,
      body: { error: "no creature has that slug" },
    });
  });

  it("answer a removal with the confirmation payload until confirmed", async () => {
    const port = fakePort();
    const h = handlers(port);
    expect(await call(h.removeCreature, "DELETE", "/creatures/pip", { slug: "pip" })).toEqual({
      status: 409,
      body: { error: "removing pip needs confirmed=true", removal: pipRemoval },
    });
    expect(
      await call(h.removeCreature, "DELETE", "/creatures/pip?confirmed=true&keepWorkshop=true", {
        slug: "pip",
      }),
    ).toEqual({ status: 200, body: { removed: true, removal: pipRemoval } });
    expect(port.choices).toEqual([
      { verb: "removal", slug: "pip", choice: { confirmed: false } },
      { verb: "remove", slug: "pip", choice: { confirmed: true, keepWorkshop: true } },
    ]);
  });

  it("refuse a removal query it does not understand and 404 an unknown slug", async () => {
    const h = handlers(fakePort());
    expect(
      (await call(h.removeCreature, "DELETE", "/creatures/pip?confirmed=yes", { slug: "pip" }))
        .status,
    ).toBe(400);
    expect(
      (await call(h.removeCreature, "DELETE", "/creatures/pip?keepWorkshop=maybe", { slug: "pip" }))
        .status,
    ).toBe(400);
    expect(
      (await call(h.removeCreature, "DELETE", "/creatures/mo?confirmed=true", { slug: "mo" }))
        .status,
    ).toBe(404);
    expect((await call(h.removeCreature, "DELETE", "/creatures/mo", { slug: "mo" })).status).toBe(
      404,
    );
  });

  it("add eleven operations whose ids the document carries exactly once", () => {
    const ids = routes.map((route) => route.operationId);
    expect(creatureRoutes).toHaveLength(11);
    for (const route of creatureRoutes) {
      expect(
        ids.filter((id) => id === route.operationId),
        route.operationId,
      ).toHaveLength(1);
    }
    expect(operationOf(creatureRoutes[2]).parameters).toEqual([
      { name: "slug", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(operationOf(creatureRoutes[1]).requestBody?.required).toBe(true);
  });
});

describe("the draft and the removal choice", () => {
  it("keep a draft's name as typed and drop what was not given", () => {
    expect(creatureDraftOf({ name: "Pip the Second" })).toEqual({ name: "Pip the Second" });
    expect(creatureDraftOf({ name: "Pip", workshop: "ws-7", models: {} })).toEqual({
      name: "Pip",
      workshop: "ws-7",
      models: {},
    });
  });

  it("read the removal query", () => {
    expect(removalChoiceOf(new URLSearchParams(""))).toEqual({ confirmed: false });
    expect(removalChoiceOf(new URLSearchParams("confirmed=true"))).toEqual({ confirmed: true });
    expect(removalChoiceOf(new URLSearchParams("keepWorkshop=false"))).toEqual({
      confirmed: false,
      keepWorkshop: false,
    });
    expect(removalChoiceOf(new URLSearchParams("confirmed=1"))).toBeUndefined();
  });
});

describe("changing a creature", () => {
  it("patch the name, body and policy and answer the summary", async () => {
    const port = fakePort();
    const h = handlers(port);
    const patch = {
      name: "Pip the Second",
      body: { skin: "otter", seed: 9 },
      models: { loop: { provider: "ollama", model: "qwen3:8b" } },
      cloudFallback: false,
    };

    const answer = await call(h.updateCreature, "PATCH", "/creatures/pip", { slug: "pip" }, patch);

    expect(answer).toEqual({ status: 200, body: { ...pip, name: "Pip the Second" } });
    expect(port.patches).toEqual([patch]);
  });

  it.each([
    ["nothing to change", {}],
    ["a blank name", { name: " " }],
    ["an empty body", { body: {} }],
    ["a seed out of range", { body: { seed: -1 } }],
    ["a fractional seed", { body: { seed: 1.5 } }],
    ["an unknown body key", { body: { hue: 3 } }],
    ["a workshop, which is not the keeper's to patch here", { workshop: "ws-7" }],
    ["a cloud fallback that is not a boolean", { cloudFallback: "yes" }],
  ])("refuse a patch with %s", async (_what, body) => {
    const port = fakePort();
    const answer = await call(
      handlers(port).updateCreature,
      "PATCH",
      "/creatures/pip",
      { slug: "pip" },
      body,
    );

    expect(answer.status).toBe(400);
    expect(port.patches).toEqual([]);
  });

  it("answer 404 for an unknown creature and 400 when the file would be invalid", async () => {
    const h = handlers(fakePort());

    expect(
      (await call(h.updateCreature, "PATCH", "/creatures/mo", { slug: "mo" }, { name: "Mo" }))
        .status,
    ).toBe(404);
    const refused = await call(
      h.updateCreature,
      "PATCH",
      "/creatures/pip",
      { slug: "pip" },
      { body: { skin: "refused" } },
    );
    expect(refused).toEqual({ status: 400, body: { error: "malformed creature.json: no" } });
  });

  it("read a patch the way the profile sends it", () => {
    expect(creaturePatchOf({ models: { decide: "inherit" } })).toEqual({
      models: { decide: "inherit" },
    });
    expect(creaturePatchOf({ body: { skin: "kid" } })).toEqual({ body: { skin: "kid" } });
  });
});

describe("the shadow report route", () => {
  it("serve the creature's report", async () => {
    const h = handlers(fakePort());

    expect(
      await call(h.readCreatureReport, "GET", "/creatures/pip/report", { slug: "pip" }),
    ).toEqual({ status: 200, body: pipReport });
    expect(
      (await call(h.readCreatureReport, "GET", "/creatures/mo/report", { slug: "mo" })).status,
    ).toBe(404);
  });

  it.each([
    ["no node state is known", new ShadowReportUnserved()],
    ["ratchet cannot be loaded", new RatchetUnreachableError(new Error("not found"))],
  ])("answer 503 when %s", async (_what, failure) => {
    const h = handlers(
      fakePort(undefined, async () => {
        throw failure;
      }),
    );

    const answer = await call(h.readCreatureReport, "GET", "/creatures/pip/report", {
      slug: "pip",
    });

    expect(answer).toEqual({ status: 503, body: { error: failure.message } });
  });
});

describe("pausing and resuming a creature", () => {
  it("pause through the routine service the host serves", async () => {
    const port = fakePort();
    const routines = {
      list: async () => [{ id: "triage", routine: { id: "triage", enabled: true } }],
    } as unknown as RoutineService;
    const h = handlers(port, { routines });

    const paused = await call(h.pauseCreature, "POST", "/creatures/pip/pause", { slug: "pip" });
    const resumed = await call(h.resumeCreature, "POST", "/creatures/pip/resume", { slug: "pip" });

    expect(paused).toEqual({
      status: 200,
      body: { slug: "pip", paused: true, since: pip.created, chores: ["triage"] },
    });
    expect(resumed).toEqual({
      status: 200,
      body: { slug: "pip", paused: false, since: null, chores: [] },
    });
  });

  it("pause with no chores when the host serves no routines, and 404 an unknown creature", async () => {
    const h = handlers(fakePort());

    expect(
      (await call(h.pauseCreature, "POST", "/creatures/pip/pause", { slug: "pip" })).body,
    ).toMatchObject({ paused: true, chores: [] });
    expect(
      (await call(h.resumeCreature, "POST", "/creatures/mo/resume", { slug: "mo" })).status,
    ).toBe(404);
  });
});

describe("creating a creature on a substrate", () => {
  const raised: WorkshopView = {
    id: "pip-0a1b2c",
    creature: "pip",
    substrate: "sbx",
    state: "stopped",
    workdir: "/home/agent/workspace",
    brokers: [],
    limitations: [],
    display: true,
    createdAt: "2026-11-06T09:00:00.000Z",
  };

  function workshopsPort(
    answer: WorkshopView | { refused: "unavailable"; error: string },
    held: readonly WorkshopView[] = [],
  ) {
    const created: unknown[] = [];
    const started: string[] = [];
    const port = {
      created,
      started,
      list: async () => [...held],
      create: async (request: unknown) => {
        created.push(request);
        return answer;
      },
      start: async (id: string) => {
        started.push(id);
        return { ...raised, state: "running" };
      },
      remove: async (id: string, keptDisk: boolean) => ({ id, keptDisk }),
    };
    return port as unknown as WorkshopsPort & { created: unknown[]; started: string[] };
  }

  it("raise the workshop and name it in the draft", async () => {
    const port = fakePort(async (draft) => ({ ...pip, workshop: draft.workshop ?? "host" }));
    const workshops = workshopsPort(raised);
    const h = handlers(port, { workshops });

    const answer = await call(
      h.createCreature,
      "POST",
      "/creatures",
      {},
      {
        name: "Wren",
        substrate: "sbx",
      },
    );

    expect(answer).toEqual({ status: 201, body: { ...pip, workshop: raised.id } });
    expect(workshops.created).toEqual([{ creature: "wren", substrate: "sbx" }]);
    expect(port.drafts).toEqual([{ name: "Wren", workshop: raised.id }]);
    expect(workshops.started).toEqual([raised.id]);
  });

  it("answer the substrate's refusal and write no creature", async () => {
    const port = fakePort();
    const refusal = { refused: "unavailable" as const, error: "the sbx CLI is not installed" };
    const workshops = workshopsPort(refusal);
    const h = handlers(port, { workshops });

    const answer = await call(
      h.createCreature,
      "POST",
      "/creatures",
      {},
      {
        name: "Wren",
        substrate: "sbx",
      },
    );

    expect(answer).toEqual({ status: 503, body: refusal });
    expect(port.drafts).toEqual([]);
    expect(workshops.started).toEqual([]);
  });

  it("refuse in words a name whose slug owns a workshop on this node from another workspace, and raise nothing", async () => {
    const port = fakePort();
    const bea = { ...raised, id: "bea-dc1057", creature: "bea" };
    const workshops = workshopsPort(raised, [bea]);
    const h = handlers(port, { workshops });

    const answer = await call(
      h.createCreature,
      "POST",
      "/creatures",
      {},
      { name: "Bea", substrate: "host" },
    );

    expect(answer).toEqual({
      status: 409,
      body: { refused: "conflict", error: nameTakenOnNodeLine("bea", "bea-dc1057") },
    });
    expect(nameTakenOnNodeLine("bea", "bea-dc1057")).toBe(
      "the name bea is taken on this node: workshop bea-dc1057 belongs to a creature made in another workspace, and two creatures never share one · choose another name, or remove that workshop first (DELETE /workshops/bea-dc1057)",
    );
    expect(workshops.created).toEqual([]);
    expect(port.drafts).toEqual([]);
    expect(workshops.started).toEqual([]);
  });

  it("leave a creature that lives in this workspace to the creation's own conflict, not the node's", async () => {
    const port = fakePort();
    const workshops = workshopsPort(raised, [raised]);
    const h = handlers(port, { workshops });

    const answer = await call(
      h.createCreature,
      "POST",
      "/creatures",
      {},
      { name: "Pip", substrate: "host" },
    );

    expect(answer).toEqual({
      status: 409,
      body: { refused: "conflict", error: "a creature named pip already exists" },
    });
    expect(workshops.created).toEqual([]);
  });

  it("refuse a substrate with no workshops served, an unknown kind, or both a workshop and a substrate", async () => {
    const h = handlers(fakePort());

    expect(
      (await call(h.createCreature, "POST", "/creatures", {}, { name: "Pip", substrate: "sbx" }))
        .status,
    ).toBe(503);
    expect(creatureDraftOf({ name: "Pip", substrate: "wsl" })).toBeUndefined();
    expect(creatureDraftOf({ name: "Pip", substrate: "host", workshop: "ws-7" })).toBeUndefined();
    expect(creatureDraftOf({ name: "Pip", substrate: "host" })).toEqual({
      name: "Pip",
      substrate: "host",
    });
  });
});

describe("a creature's inbound policy", () => {
  it("patches who may message it and refuses a policy that is not one", async () => {
    expect(creaturePatchOf({ inbound: "nobody" })).toEqual({ inbound: "nobody" });
    expect(creaturePatchOf({ inbound: { named: ["ada", "mo@laptop"] } })).toEqual({
      inbound: { named: ["ada", "mo@laptop"] },
    });
    for (const inbound of [
      "everyone",
      { named: [] },
      { named: ["Ada"] },
      { named: ["ada"], grants: ["exec"] },
    ]) {
      expect(creaturePatchOf({ inbound })).toBeUndefined();
    }
    const port = fakePort();
    const answer = await call(
      handlers(port).updateCreature,
      "PATCH",
      "/creatures/pip",
      { slug: "pip" },
      { inbound: "paired" },
    );
    expect(answer).toEqual({ status: 200, body: pip });
    expect(port.patches).toEqual([{ inbound: "paired" }]);
  });
});

describe("the promote and demote routes", () => {
  const reportAt = (nodeState: string) => async () => ({
    ...pipReport,
    ledgerPath: keeperLedgerPath(nodeState),
  });

  it("read exactly one rule class from the body", () => {
    expect(ruleClassOf({ ruleClass: " bash make build * " })).toBe("bash make build *");
    for (const body of [
      {},
      { ruleClass: "" },
      { ruleClass: 3 },
      { ruleClass: "x", all: true },
      null,
    ]) {
      expect(ruleClassOf(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  it("refuse a body without one rule class, and a creature that is not there", async () => {
    const h = handlers(fakePort(undefined, reportAt(await scratchNode())));
    const params = { slug: "pip" };
    expect(
      (await call(h.promoteCreatureClass, "POST", "/creatures/pip/promote", params, {})).status,
    ).toBe(400);
    expect(
      (await call(h.demoteCreatureClass, "POST", "/creatures/pip/demote", params, {})).status,
    ).toBe(400);
    const missing = await call(
      h.promoteCreatureClass,
      "POST",
      "/creatures/mo/promote",
      { slug: "mo" },
      {
        ruleClass: promotableClass,
      },
    );
    expect(missing.status).toBe(404);
  });

  it("refuse a one-way door with the sentence the CLI prints", async () => {
    const h = handlers(fakePort(undefined, reportAt(await scratchNode())));
    const answer = await call(
      h.promoteCreatureClass,
      "POST",
      "/creatures/pip/promote",
      { slug: "pip" },
      {
        ruleClass: "one-way door",
      },
    );
    expect(answer).toEqual({
      status: 409,
      body: {
        promoted: false,
        refusal: "one-way-door",
        sentence:
          '"one-way door" is a one-way door: destructive forms in keywork\'s K9 sense stay ' +
          "ask-only, and no evidence promotes them.",
      },
    });
  });

  it("promote one class for this creature on the planned sample, and demote it again", async () => {
    const h = handlers(fakePort(undefined, reportAt(await promotableNode(await loadRatchet()))));
    const body = { ruleClass: promotableClass };
    const promoted = await call(
      h.promoteCreatureClass,
      "POST",
      "/creatures/pip/promote",
      { slug: "pip" },
      body,
    );
    expect(promoted).toMatchObject({
      status: 200,
      body: {
        promoted: true,
        promotion: { ruleClass: promotableClass, creature: "pip", bar: 0.96 },
      },
    });
    const again = await call(
      h.promoteCreatureClass,
      "POST",
      "/creatures/pip/promote",
      { slug: "pip" },
      body,
    );
    expect(again).toMatchObject({ status: 409, body: { refusal: "promoted" } });
    const demoted = await call(
      h.demoteCreatureClass,
      "POST",
      "/creatures/pip/demote",
      { slug: "pip" },
      body,
    );
    expect(demoted).toMatchObject({
      status: 200,
      body: {
        demoted: true,
        demotion: { ruleClass: promotableClass, creature: "pip", by: "keeper" },
      },
    });
    const twice = await call(
      h.demoteCreatureClass,
      "POST",
      "/creatures/pip/demote",
      { slug: "pip" },
      body,
    );
    expect(twice).toMatchObject({ status: 200, body: { demoted: false } });
  }, 120_000);

  it("answer 503 when the node state is unknown", async () => {
    const h = handlers(
      fakePort(undefined, async () => {
        throw new ShadowReportUnserved();
      }),
    );
    const answer = await call(
      h.promoteCreatureClass,
      "POST",
      "/creatures/pip/promote",
      { slug: "pip" },
      {
        ruleClass: promotableClass,
      },
    );
    expect(answer).toEqual({ status: 503, body: { error: new ShadowReportUnserved().message } });
  });
});
