import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { environmentSecrets, modelProviderBrokers } from "./brokers.ts";
import { patternCovers } from "./egress.ts";
import type { CliRunner, Invocation } from "./runner.ts";
import {
  hasSecretService,
  qualifiedSbxVersion,
  refusingReset,
  sbxSubstrate,
  workshopKitDir,
} from "./sbx.ts";
import { workshopSpecSchema } from "./spec.ts";
import { type FakeRule, fakeSbx } from "./testing.ts";

const tempDir = scratchDirs("keywork-workshop-sbx-");
const secret = "test-anthropic-key-5e0d";
const brokers = modelProviderBrokers(environmentSecrets({ ANTHROPIC_API_KEY: secret }));
const noPause = async () => undefined;

interface TranscriptStep {
  readonly args: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
}

describe("the sbx adapter against a recorded transcript", () => {
  it("drives create, start, exec, stop and remove exactly as recorded", async () => {
    const transcript = JSON.parse(
      await readFile(new URL("./fixtures/sbx-lifecycle.transcript.json", import.meta.url), "utf8"),
    ) as { sbx: string; steps: TranscriptStep[] };
    const replay = transcriptRunner(transcript.steps, {
      "{kit}": workshopKitDir,
      "{secret}": secret,
    });
    const substrate = sbxSubstrate({
      run: replay.run,
      stateDir: await tempDir(),
      brokers,
      pause: noPause,
      newId: () => "pip-0a1b2c",
    });

    const workshop = await substrate.create(
      workshopSpecSchema.parse({
        creature: "pip",
        substrate: "sbx",
        egress: [{ host: "pypi.org" }],
        brokers: ["anthropic"],
      }),
    );
    await substrate.start(workshop);
    const ready = await substrate.exec(workshop, { run: "echo ready" });
    await substrate.remove(workshop, true);
    await substrate.remove(workshop, false);

    expect(transcript.sbx).toBe(qualifiedSbxVersion);
    expect(ready.stdout).toBe("ready\n");
    expect(replay.remaining()).toEqual([]);
  });
});

describe("the sbx adapter", () => {
  it("refuses an sbx other than the qualified pin before creating anything", async () => {
    const sbx = fakeSbx({ version: "0.46.0" });
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });

    await expect(substrate.create(spec())).rejects.toThrow(
      `sbx 0.46.0 is not the qualified ${qualifiedSbxVersion}`,
    );
    expect(sbx.sandboxes.size).toBe(0);
  });

  it("blocks a downgrade below a version that already touched the database", async () => {
    const stateDir = await tempDir();
    await writeFile(join(stateDir, "sbx-version"), "0.46.0", "utf8");
    const substrate = sbxSubstrate({ run: fakeSbx().run, stateDir, pause: noPause });

    await expect(substrate.create(spec())).rejects.toThrow("downgrades are blocked");
  });

  it("never lets sbx reset through", async () => {
    const calls: Invocation[] = [];
    const run: CliRunner = async (invocation) => {
      calls.push(invocation);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };

    await expect(refusingReset(run)({ args: ["reset", "--force"] })).rejects.toThrow(
      "never scripted",
    );
    expect(calls).toEqual([]);
  });

  it("stops and starts a sandbox that is running but not responding, then restarts the daemon", async () => {
    const sbx = fakeSbx({
      startsAs: ["running (not responding)", "running (not responding)", "running"],
    });
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });
    const workshop = await substrate.create(spec());

    await substrate.start(workshop);

    expect(await substrate.health(workshop)).toBe("up");
    expect(sbx.calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(
      expect.arrayContaining([`stop ${workshop.handle}`, "daemon restart"]),
    );
    expect(sbx.daemonRestarts()).toBe(1);
  });

  it("reports a start that never answers as unhealthy", async () => {
    const hung = "running (not responding)" as const;
    const sbx = fakeSbx({ startsAs: [hung, hung, hung] });
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });
    const workshop = await substrate.create(spec());

    await expect(substrate.start(workshop)).rejects.toMatchObject({ reason: "unhealthy" });
  });

  it("sizes the disks at creation through the documented environment", async () => {
    const sbx = fakeSbx();
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });

    await substrate.create(spec({ disks: { rootGb: 40, dockerGb: 20 } }));

    const create = sbx.calls.find((call) => call.args[0] === "create");
    expect(create?.env).toEqual({
      DOCKER_SANDBOXES_ROOT_SIZE: "40g",
      DOCKER_SANDBOXES_DOCKER_SIZE: "20g",
    });
  });

  it("leaves the keeper's other sandboxes alone and seals this one from deny-all", async () => {
    const sbx = fakeSbx({ globalAllows: ["*.googleapis.com", "*.npmjs.org", "api.anthropic.com"] });
    const substrate = sbxSubstrate({
      run: sbx.run,
      stateDir: await tempDir(),
      brokers,
      pause: noPause,
    });

    const workshop = await substrate.create(
      spec({ egress: [{ host: "pypi.org" }], brokers: ["anthropic"] }),
    );

    const reachable = effectiveAllows(sbx.rules, workshop.handle);
    expect(reachable.sort()).toEqual(["api.anthropic.com", "pypi.org"]);
    expect(reachable.join(" ")).not.toContain("*");
    expect(sbx.rules.filter((rule) => rule.scope === "(global)")).toHaveLength(3);
  });

  it("refuses before any sandbox exists when an inherited wildcard covers a wanted host", async () => {
    const sbx = fakeSbx({ globalAllows: ["*.github.com"] });
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });

    await expect(
      substrate.create(spec({ egress: [{ host: "api.github.com" }] })),
    ).rejects.toMatchObject({
      reason: "conflict",
    });
    expect(sbx.calls.some((call) => call.args[0] === "create")).toBe(false);
  });

  it("removes a half-sealed sandbox when its egress cannot be applied", async () => {
    const sbx = fakeSbx({
      refuse: (args) => (args[1] === "allow" ? "policy store is locked" : undefined),
    });
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });

    await expect(substrate.create(spec({ egress: [{ host: "pypi.org" }] }))).rejects.toThrow(
      "policy store is locked",
    );
    expect(sbx.sandboxes.size).toBe(0);
  });

  it("moves files through sbx exec and a copy from a relative staging path", async () => {
    const sbx = fakeSbx();
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });
    const workshop = await substrate.create(spec());
    await substrate.start(workshop);

    await substrate.files(workshop).write("notes/barn.md", "two doors\n");

    const copy = sbx.calls.find((call) => call.args[0] === "cp");
    expect(copy?.args[1]).not.toMatch(/[:\\/]/);
    expect(copy?.args[2]).toBe(`${workshop.handle}:/home/agent/workspace/notes/barn.md`);
    expect(
      sbx.sandboxes.get(workshop.handle)?.files.get("/home/agent/workspace/notes/barn.md"),
    ).toBe("two doors\n");
    expect(await substrate.files(workshop).read("/home/agent/workspace/notes/barn.md")).toBe(
      "two doors\n",
    );
  });

  it("says so when brokered credentials would sit in a plain file (RUN-009)", async () => {
    const make = async (secretService: boolean) =>
      sbxSubstrate({
        run: fakeSbx().run,
        stateDir: await tempDir(),
        brokers,
        pause: noPause,
        secretService,
      }).create(spec({ brokers: ["anthropic"] }));

    expect((await make(false)).limitations.join(" ")).toContain("user-readable file (RUN-009)");
    expect((await make(true)).limitations.join(" ")).not.toContain("RUN-009");
  });

  it("finds a Secret Service only where Linux has a session bus", () => {
    expect(hasSecretService("linux", {})).toBe(false);
    expect(
      hasSecretService("linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }),
    ).toBe(true);
    expect(hasSecretService("win32", {})).toBe(true);
    expect(hasSecretService("darwin", {})).toBe(true);
  });

  it("keeps the disk on remove by stopping instead of deleting", async () => {
    const sbx = fakeSbx();
    const substrate = sbxSubstrate({ run: sbx.run, stateDir: await tempDir(), pause: noPause });
    const workshop = await substrate.create(spec());
    await substrate.start(workshop);

    await substrate.remove(workshop, true);

    expect(sbx.sandboxes.get(workshop.handle)?.status).toBe("stopped");
  });
});

function spec(extra: Record<string, unknown> = {}) {
  return workshopSpecSchema.parse({ creature: "pip", substrate: "sbx", ...extra });
}

function effectiveAllows(rules: readonly FakeRule[], sandbox: string): string[] {
  const applies = rules.filter((rule) => rule.scope === "(global)" || rule.scope === sandbox);
  const denied = applies.filter((rule) => rule.decision === "deny").map((rule) => rule.resource);
  return [
    ...new Set(
      applies
        .filter((rule) => rule.decision === "allow")
        .map((rule) => rule.resource)
        .filter((resource) => !denied.some((pattern) => patternCovers(pattern, resource))),
    ),
  ];
}

function transcriptRunner(
  steps: readonly TranscriptStep[],
  placeholders: Readonly<Record<string, string>>,
): { run: CliRunner; remaining(): readonly TranscriptStep[] } {
  const queue = [...steps];
  const filled = (text: string) => placeholders[text] ?? text;
  return {
    run: async (invocation) => {
      const step = queue.shift();
      expect(invocation.args).toEqual(step?.args.map(filled));
      if (step?.input !== undefined) expect(invocation.input).toBe(filled(step.input));
      if (step?.env !== undefined) expect(invocation.env).toEqual(step.env);
      return { code: step?.exit ?? 1, stdout: step?.stdout ?? "", stderr: "", timedOut: false };
    },
    remaining: () => queue,
  };
}
