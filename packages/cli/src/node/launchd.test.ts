import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapAttempts,
  bootstrapRetryMs,
  defaultAgentLabel,
  launchAgentPlist,
  launchdAgentManager,
  serviceFields,
} from "./launchd.ts";
import type { Registration } from "./manager.ts";
import {
  keeperHome,
  keeperUid,
  launchctlRecordings,
  RecordedLaunchctl,
} from "./platform-fixtures.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-launchd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    name: defaultAgentLabel,
    launch: {
      program: `${keeperHome}/.bun/bin/bun`,
      args: [`${keeperHome}/src/stead/repos/keywork/packages/cli/src/main.ts`],
    },
    args: ["node", "run", "--supervise"],
    workingDirectory: `${keeperHome}/.keywork/node`,
    account: { name: "keeper", domain: null, uid: keeperUid },
    path: `${keeperHome}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    logFile: `${keeperHome}/.keywork/node/logs/service.log`,
    ...overrides,
  };
}

function manager(launchctl: RecordedLaunchctl) {
  return launchdAgentManager({ run: launchctl.run, agentsDir: dir, uid: keeperUid });
}

const plistFile = () => join(dir, `${defaultAgentLabel}.plist`);

describe("the LaunchAgent definition", () => {
  const plist = launchAgentPlist(registration());

  it("runs in the keeper's own GUI session, never as a daemon or as root", () => {
    expect(plist).not.toMatch(/UserName|GroupName|LaunchDaemons|<key>root<\/key>/);
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Standard</string>");
  });

  it("is restarted by launchd only after a failed exit, throttled, and loaded at login", () => {
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    );
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  it("launches the supervisor with one string per argument and the PATH it was installed with", () => {
    expect(plist).toContain(
      [
        "  <key>ProgramArguments</key>",
        "  <array>",
        `    <string>${keeperHome}/.bun/bin/bun</string>`,
        `    <string>${keeperHome}/src/stead/repos/keywork/packages/cli/src/main.ts</string>`,
        "    <string>node</string>",
        "    <string>run</string>",
        "    <string>--supervise</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${keeperHome}/.keywork/node`);
    expect(plist).toContain(
      `<key>PATH</key>\n    <string>${keeperHome}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>`,
    );
  });

  it("escapes what XML cannot carry", () => {
    const odd = launchAgentPlist(
      registration({ launch: { program: "/opt/A&B <tools>/bun", args: [] } }),
    );
    expect(odd).toContain("<string>/opt/A&amp;B &lt;tools&gt;/bun</string>");
  });
});

describe("the launchd agent manager against recorded launchctl output", () => {
  it("writes the plist, clears any old load and bootstraps it into the keeper's GUI domain", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const installed = await manager(launchctl).install(registration(), {
      start: true,
      linger: false,
    });
    expect(installed).toEqual({
      ok: true,
      did: [`wrote ${plistFile()}`, `loaded ${defaultAgentLabel} into gui/${keeperUid}`],
    });
    expect(readFileSync(plistFile(), "utf8")).toBe(launchAgentPlist(registration()));
    expect(launchctl.calls).toEqual([
      ["launchctl", "bootout", `gui/${keeperUid}/${defaultAgentLabel}`],
      ["launchctl", "bootstrap", `gui/${keeperUid}`, plistFile()],
    ]);
  });

  it("writes the plist without loading it when asked not to start", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    await agents.install(registration(), { start: false, linger: false });
    expect(launchctl.calls).toEqual([]);
    expect(await agents.status(defaultAgentLabel)).toEqual({
      installed: true,
      running: false,
      state: "installed, not loaded",
      pid: null,
      notes: [],
    });
  });

  it("reinstalls over a loaded agent, which launchctl alone would refuse", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    await agents.install(registration(), { start: true, linger: false });
    const again = await agents.install(registration(), { start: true, linger: false });
    expect(again.ok).toBe(true);
    expect(launchctl.verbs()).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
  });

  it("waits out a boot-out launchctl has not finished before bootstrapping again", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    launchctl.bootoutsStillSettling = 2;
    const waited: number[] = [];
    const agents = launchdAgentManager({
      run: launchctl.run,
      agentsDir: dir,
      uid: keeperUid,
      wait: async (ms) => {
        waited.push(ms);
      },
    });
    const installed = await agents.install(registration(), { start: true, linger: false });
    expect(installed).toEqual({
      ok: true,
      did: [
        `wrote ${plistFile()}`,
        "waited for launchctl to finish the boot-out (2 retries)",
        `loaded ${defaultAgentLabel} into gui/${keeperUid}`,
      ],
    });
    expect(launchctl.verbs()).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);
    expect(waited).toEqual([bootstrapRetryMs, bootstrapRetryMs]);
  });

  it("gives up on a boot-out that never settles and passes on what launchctl said", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    launchctl.bootoutsStillSettling = 10;
    const agents = launchdAgentManager({
      run: launchctl.run,
      agentsDir: dir,
      uid: keeperUid,
      wait: async () => {},
    });
    const installed = await agents.install(registration(), { start: true, linger: false });
    expect(installed.ok).toBe(false);
    expect(launchctl.verbs()).toEqual([
      "bootout",
      ...Array.from({ length: bootstrapAttempts }, () => "bootstrap"),
    ]);
  });

  it("refuses root before touching anything", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const installed = await manager(launchctl).install(
      registration({ account: { name: "root", domain: null, uid: 0 } }),
      { start: true, linger: false },
    );
    expect(installed).toMatchObject({
      ok: false,
      problem: expect.stringContaining("never as root"),
    });
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(plistFile())).toBe(false);
  });

  it("reads the service's own state and pid from launchctl print, never a coalition's", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    expect(await agents.status(defaultAgentLabel)).toEqual({
      installed: false,
      running: false,
      state: "not installed",
      pid: null,
      notes: [],
    });
    await agents.install(registration(), { start: true, linger: false });
    expect(await agents.status(defaultAgentLabel)).toEqual({
      installed: true,
      running: true,
      state: "running",
      pid: 8124,
      notes: ["last exit code (never exited)"],
    });
  });

  it("reports a crashed supervisor waiting out the throttle, and one killed by a signal", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    await agents.install(registration(), { start: true, linger: false });
    launchctl.crash(defaultAgentLabel, "spawn");
    expect(await agents.status(defaultAgentLabel)).toEqual({
      installed: true,
      running: false,
      state: "spawn scheduled",
      pid: null,
      notes: ["last exit code 1", "launchd starts it again after the 10 s throttle"],
    });
    launchctl.crash(defaultAgentLabel, "killed");
    expect(await agents.status(defaultAgentLabel)).toMatchObject({
      running: false,
      state: "not running",
      notes: ["last exit code (never exited)", "last terminating signal Killed: 9"],
    });
  });

  it("boots out and removes the agent on uninstall, and says so when there was none", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    expect(await agents.uninstall(defaultAgentLabel)).toEqual({
      ok: true,
      did: [`no launchd agent ${defaultAgentLabel} was installed`],
    });
    await agents.install(registration(), { start: true, linger: false });
    expect(await agents.uninstall(defaultAgentLabel)).toEqual({
      ok: true,
      did: [`unloaded ${defaultAgentLabel}`, `removed ${plistFile()}`],
    });
    expect(launchctl.loaded.size).toBe(0);
    expect(existsSync(plistFile())).toBe(false);
    expect(await agents.status(defaultAgentLabel)).toMatchObject({ installed: false });
  });

  it("starts an agent a stop booted out by loading its plist again, unchanged", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    await agents.install(registration(), { start: true, linger: false });
    const written = readFileSync(plistFile(), "utf8");
    expect(await agents.stop(defaultAgentLabel)).toEqual({
      ok: true,
      did: [`unloaded ${defaultAgentLabel}`],
    });
    expect(await agents.start(defaultAgentLabel)).toEqual({
      ok: true,
      did: [`loaded ${defaultAgentLabel} into gui/${keeperUid}`],
    });
    expect(launchctl.verbs()).toEqual([
      "bootout",
      "bootstrap",
      "bootout",
      "kickstart",
      "bootstrap",
    ]);
    expect(readFileSync(plistFile(), "utf8")).toBe(written);
    expect(await agents.status(defaultAgentLabel)).toMatchObject({ running: true, pid: 8125 });
  });

  it("restarts a loaded agent in place with kickstart", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    await agents.install(registration(), { start: true, linger: false });
    expect(await agents.start(defaultAgentLabel)).toEqual({
      ok: true,
      did: [`started ${defaultAgentLabel}`],
    });
    expect(launchctl.verbs()).toEqual(["bootout", "bootstrap", "kickstart"]);
  });

  it("reads back the program the plist runs, and nothing when there is no plist", async () => {
    const agents = manager(new RecordedLaunchctl(keeperUid));
    expect(await agents.program(defaultAgentLabel)).toBeUndefined();
    await agents.install(
      registration({ launch: { program: "/Applications/A&B <x>/keywork", args: [] } }),
      { start: false, linger: false },
    );
    expect(await agents.program(defaultAgentLabel)).toBe("/Applications/A&B <x>/keywork");
  });

  it("passes on what launchctl said when it refuses", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const agents = manager(launchctl);
    expect(await agents.start("missing.agent")).toEqual({
      ok: false,
      problem: `launchctl kickstart -k gui/${keeperUid}/missing.agent exited 113: Could not find service "missing.agent" in domain for user gui: ${keeperUid}`,
      did: [],
    });
    launchctl.guiSession = false;
    const headless = await agents.install(registration(), { start: true, linger: false });
    expect(headless).toEqual({
      ok: false,
      problem: `launchctl bootstrap gui/${keeperUid} ${plistFile()} exited 125: Bootstrap failed: 125: Domain does not support specified action`,
      did: [`wrote ${plistFile()}`],
    });
  });
});

describe("serviceFields", () => {
  it("keeps only the service's top-level fields from a recorded print", () => {
    const fields = serviceFields(launchctlRecordings.printRunning(defaultAgentLabel, 8124));
    expect(fields.get("state")).toBe("running");
    expect(fields.get("pid")).toBe("8124");
    expect(fields.get("job state")).toBe("running");
    expect(fields.get("ID")).toBeUndefined();
    expect(fields.get("PATH => /usr/bin:/bin:/usr/sbin:/sbin")).toBeUndefined();
  });
});
