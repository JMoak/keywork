import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { hostSubstrate } from "./host.ts";
import { sbxSubstrate } from "./sbx.ts";
import { type WorkshopSpec, workshopSpecSchema } from "./spec.ts";
import { type SubstrateKind, WorkshopRefusal, type WorkshopSubstrate } from "./substrate.ts";
import { fakeSbx, refusingSandboxHost } from "./testing.ts";

const tempDir = scratchDirs("keywork-workshop-");

interface Harness {
  readonly substrate: WorkshopSubstrate;
  readonly spec: WorkshopSpec;
}

const adapters: ReadonlyArray<readonly [SubstrateKind, () => Promise<Harness>]> = [
  [
    "host",
    async () => ({
      substrate: hostSubstrate({ stateDir: await tempDir(), sandboxHost: refusingSandboxHost }),
      spec: workshopSpecSchema.parse({ creature: "pip", substrate: "host" }),
    }),
  ],
  [
    "sbx",
    async () => ({
      substrate: sbxSubstrate({
        run: fakeSbx().run,
        stateDir: await tempDir(),
        pause: async () => undefined,
      }),
      spec: workshopSpecSchema.parse({ creature: "pip", substrate: "sbx" }),
    }),
  ],
];

describe.each(adapters)("the %s workshop substrate", (kind, harness) => {
  it("creates a workshop for the one creature it names, down until started", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);

    expect(substrate.kind).toBe(kind);
    expect(workshop).toMatchObject({ creature: "pip", substrate: kind });
    expect(workshop.id).toMatch(/^pip-[0-9a-f]{6}$/);
    expect(await substrate.health(workshop)).toBe("down");
  });

  it("comes up on start and goes down on stop", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);

    await substrate.start(workshop);
    expect(await substrate.health(workshop)).toBe("up");
    await substrate.stop(workshop);
    expect(await substrate.health(workshop)).toBe("down");
  });

  it("runs a command in its workdir and hands back the exit code", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);
    await substrate.start(workshop);

    const echoed = await substrate.exec(workshop, { run: "echo conformance" });
    const failed = await substrate.exec(workshop, { run: "exit 3" });

    expect(echoed.stdout.trim()).toBe("conformance");
    expect(echoed).toMatchObject({ code: 0, timedOut: false });
    expect(failed.code).toBe(3);
  });

  it("refuses a command while the workshop is stopped", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);

    await expect(substrate.exec(workshop, { run: "echo early" })).rejects.toMatchObject({
      reason: "not-running",
    });
  });

  it("writes and reads files through its own file port, making parent directories", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);
    await substrate.start(workshop);
    const files = substrate.files(workshop);

    await files.write("notes/plan.md", "raise the barn\n");

    expect(await files.read("notes/plan.md")).toBe("raise the barn\n");
  });

  it("rejects reading a file that is not there", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);
    await substrate.start(workshop);

    await expect(substrate.files(workshop).read("nowhere.txt")).rejects.toThrow();
  });

  it("defers snapshots and forks past milestone one", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);
    const snapshot = { workshop: workshop.id, label: "before", takenAt: "2026-11-05T00:00:00Z" };

    await expect(substrate.snapshot(workshop, "before")).rejects.toBeInstanceOf(WorkshopRefusal);
    await expect(substrate.fork(snapshot)).rejects.toMatchObject({ reason: "deferred" });
  });

  it("offers a display port only where a display can exist", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);

    expect(substrate.display(workshop) === undefined).toBe(kind === "host");
  });

  it("is down and refuses commands once removed", async () => {
    const { substrate, spec } = await harness();
    const workshop = await substrate.create(spec);
    await substrate.start(workshop);

    await substrate.remove(workshop, false);

    expect(await substrate.health(workshop)).toBe("down");
    await expect(substrate.exec(workshop, { run: "echo gone" })).rejects.toThrow();
  });
});
