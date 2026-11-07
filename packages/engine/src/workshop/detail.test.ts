import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionRule } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { unreportedConnections } from "./detail.ts";
import { hostDiskUnbounded, hostMemoryShared, hostSubstrate } from "./host.ts";
import { sbxSubstrate } from "./sbx.ts";
import { diskIn, memoryIn } from "./sbx-output.ts";
import { fakeDiskFree, fakeMeminfo, fakeSbx, refusingSandboxHost } from "./testing.ts";
import { type Refused, Workshops, type WorkshopView } from "./workshops.ts";

const scratch = scratchDirs("keywork-workshop-detail-");

const at = new Date("2026-11-06T09:00:00.000Z");

const hostGrant: PermissionRule = { action: "workshop.exec", resource: "wren", effect: "allow" };

async function node() {
  const stateDir = await scratch();
  const sbx = fakeSbx();
  const workshops = new Workshops({
    stateDir,
    now: () => at,
    substrates: {
      host: hostSubstrate({ stateDir, sandboxHost: refusingSandboxHost }),
      sbx: sbxSubstrate({ run: sbx.run, stateDir, pause: async () => undefined, now: () => at }),
    },
  });
  return { stateDir, sbx, workshops };
}

async function raised(
  workshops: Workshops,
  request: Record<string, unknown>,
): Promise<WorkshopView> {
  const view = await workshops.create(request);
  if ("refused" in view) throw new Error(view.error);
  return view;
}

describe("a workshop's detail", () => {
  it("shows a microVM's deny-all egress, its sized disks and what it measures inside", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, {
      creature: "wren",
      substrate: "sbx",
      egress: [{ host: "pypi.org" }],
      brokers: [],
      memory: "2g",
    });
    await workshops.start(view.id);

    const detail = await workshops.detail(view.id);

    expect(detail).toMatchObject({
      id: view.id,
      egress: {
        policy: "deny-all",
        enforced: true,
        rules: [{ host: "pypi.org", methods: ["GET", "HEAD", "OPTIONS"] }],
        brokerHosts: [],
      },
      resources: {
        cpus: 2,
        memory: "2g",
        disks: { rootGb: 20, dockerGb: 10 },
        measured: {
          disk: diskIn(fakeDiskFree("/home/agent/workspace")),
          memory: memoryIn(fakeMeminfo),
          unmeasured: [],
        },
      },
      refusals: { entries: [], unreported: unreportedConnections.sbx },
      terminal: { allowed: true, log: [] },
    });
  });

  it("says a stopped microVM is measured only while it runs", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "sbx" });

    const detail = await workshops.detail(view.id);

    expect(detail).toMatchObject({
      resources: {
        measured: {
          disk: { usedBytes: null, sizeBytes: null },
          memory: { usedBytes: null, totalBytes: null },
          unmeasured: [expect.stringContaining("only while it runs")],
        },
      },
    });
  });

  it("shows a bare host as unenforced, sized by what it holds and closed to typing", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "host" });
    await mkdir(view.workdir, { recursive: true });
    await writeFile(join(view.workdir, "notes.txt"), "twelve bytes", "utf8");

    const detail = await workshops.detail(view.id);

    expect(detail).toMatchObject({
      egress: { policy: "none", enforced: false, rules: [] },
      resources: {
        disks: null,
        measured: {
          disk: { usedBytes: 12, sizeBytes: null },
          memory: { usedBytes: null, totalBytes: null },
          unmeasured: [hostDiskUnbounded, hostMemoryShared],
        },
      },
      refusals: { unreported: unreportedConnections.host },
      terminal: { allowed: false, reason: expect.stringContaining("bare host") },
    });
    expect((await workshops.detail(view.id, [hostGrant])) as { terminal: unknown }).toMatchObject({
      terminal: { allowed: true },
    });
  });

  it("refuses an unknown id", async () => {
    const { workshops } = await node();

    expect(await workshops.detail("nope-000000")).toMatchObject({ refused: "missing" });
  });
});

describe("the typed terminal", () => {
  it("runs a command inside a microVM and logs it as a keeper tool call", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "sbx" });
    await workshops.start(view.id);

    const run = await workshops.exec(view.id, { command: "pwd" });

    expect(run).toEqual({
      workshop: view.id,
      code: 0,
      stdout: "/home/agent/workspace\n",
      stderr: "",
      timedOut: false,
    });
    expect(await workshops.detail(view.id)).toMatchObject({
      terminal: {
        log: [
          {
            at: at.toISOString(),
            tool: "bash",
            origin: "keeper",
            input: { command: "pwd" },
            outcome: { code: 0, timedOut: false },
          },
        ],
      },
    });
  });

  it("refuses a bare host without the keeper's grant and logs the refusal twice over", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "host" });
    await workshops.start(view.id);

    const refused = (await workshops.exec(view.id, { command: "echo hi" })) as Refused;

    expect(refused).toMatchObject({ refused: "forbidden" });
    expect(refused.error).toContain(`resource: "${view.id}"`);
    const detail = await workshops.detail(view.id);
    expect(detail).toMatchObject({
      refusals: {
        entries: [{ at: at.toISOString(), operation: "exec", refused: "forbidden" }],
      },
      terminal: { log: [{ input: { command: "echo hi" }, outcome: { refused: "forbidden" } }] },
    });
  });

  it("runs on a bare host once the keeper grants it, inside the workshop's own workdir", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "host" });
    await workshops.start(view.id);
    await mkdir(join(view.workdir, "inner"), { recursive: true });
    await writeFile(join(view.workdir, "inner", "file.txt"), "inside\n", "utf8");

    const run = await workshops.exec(view.id, { command: "cat file.txt", cwd: "inner" }, [
      hostGrant,
    ]);

    expect(run).toMatchObject({ workshop: view.id, code: 0 });
    expect((run as { stdout: string }).stdout.trim()).toBe("inside");
  });

  it("lets the last matching keeper rule decide and treats ask as a refusal", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "sbx" });
    await workshops.start(view.id);
    const ask: PermissionRule = { action: "workshop.exec", resource: "*", effect: "ask" };

    expect(await workshops.exec(view.id, { command: "pwd" }, [ask])).toMatchObject({
      refused: "forbidden",
      error: expect.stringContaining("cannot ask"),
    });
    expect(await workshops.exec(view.id, { command: "pwd" }, [ask, hostGrant])).toMatchObject({
      code: 0,
    });
  });

  it("refuses a stopped workshop and a malformed command", async () => {
    const { workshops } = await node();
    const view = await raised(workshops, { creature: "wren", substrate: "sbx" });

    expect(await workshops.exec(view.id, { command: "pwd" })).toMatchObject({
      refused: "conflict",
    });
    expect(await workshops.exec(view.id, { command: "" })).toMatchObject({ refused: "invalid" });
    expect(await workshops.exec(view.id, { command: "pwd", shell: "zsh" })).toMatchObject({
      refused: "invalid",
    });
  });
});

describe("parsing what the microVM reports", () => {
  it("reads df -Pk and /proc/meminfo in bytes", () => {
    expect(diskIn(fakeDiskFree("/home/agent/workspace"))).toEqual({
      usedBytes: 1048576 * 1024,
      sizeBytes: 20511312 * 1024,
    });
    expect(memoryIn(fakeMeminfo)).toEqual({
      usedBytes: (4028736 - 3004736) * 1024,
      totalBytes: 4028736 * 1024,
    });
    expect(() => diskIn("df: no such file\n")).toThrow("does not understand");
    expect(() => memoryIn("MemFree: 1 kB\n")).toThrow("does not understand");
  });
});
