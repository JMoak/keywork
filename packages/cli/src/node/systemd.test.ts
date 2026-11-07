import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Registration } from "./manager.ts";
import { linuxKeeperName, RecordedSystemd } from "./platform-fixtures.ts";
import { defaultUnitName, systemdUnit, systemdUserManager } from "./systemd.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-systemd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const home = "/home/keeper";

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    name: defaultUnitName,
    launch: {
      program: `${home}/.bun/bin/bun`,
      args: [`${home}/src/stead/repos/keywork/packages/cli/src/main.ts`],
    },
    args: ["node", "run", "--supervise"],
    workingDirectory: `${home}/.keywork/node`,
    account: { name: linuxKeeperName, domain: null, uid: 1000 },
    path: `${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    logFile: `${home}/.keywork/node/logs/service.log`,
    ...overrides,
  };
}

function manager(systemd: RecordedSystemd) {
  return systemdUserManager({ run: systemd.run, unitDir: dir, user: linuxKeeperName });
}

const unitFile = () => join(dir, defaultUnitName);

describe("the systemd user unit definition", () => {
  const unit = systemdUnit(registration());

  it("runs in the keeper's user manager, never as root or another user", () => {
    expect(unit).not.toMatch(/^(User|Group|DynamicUser)=/m);
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("NoNewPrivileges=true");
  });

  it("restarts on failure under a start limit of three in five minutes, set in [Unit]", () => {
    const unitSection = unit.slice(0, unit.indexOf("[Service]"));
    expect(unitSection).toContain("StartLimitIntervalSec=300\nStartLimitBurst=3");
    expect(unit).toContain("Restart=on-failure\nRestartSec=10");
  });

  it("launches the supervisor in the node's state directory with the PATH it was installed with", () => {
    expect(unit).toContain(
      `ExecStart=${home}/.bun/bin/bun ${home}/src/stead/repos/keywork/packages/cli/src/main.ts node run --supervise`,
    );
    expect(unit).toContain(`WorkingDirectory=${home}/.keywork/node`);
    expect(unit).toContain(`Environment=PATH=${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`);
  });
});

describe("the systemd user manager against recorded systemctl output", () => {
  it("writes the unit, reloads, enables and starts it", async () => {
    const systemd = new RecordedSystemd(dir);
    const installed = await manager(systemd).install(registration(), {
      start: true,
      linger: false,
    });
    expect(installed).toEqual({
      ok: true,
      did: [
        `wrote ${unitFile()}`,
        "reloaded the user manager",
        `enabled ${defaultUnitName}`,
        `started ${defaultUnitName}`,
      ],
    });
    expect(readFileSync(unitFile(), "utf8")).toBe(systemdUnit(registration()));
    expect(systemd.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", defaultUnitName],
      ["systemctl", "--user", "restart", defaultUnitName],
    ]);
  });

  it("enables without starting when asked not to start", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    await units.install(registration(), { start: false, linger: false });
    expect(systemd.calls.map((call) => call[2])).toEqual(["daemon-reload", "enable"]);
    expect(await units.status(defaultUnitName)).toMatchObject({
      installed: true,
      running: false,
      state: "inactive (dead)",
      pid: null,
    });
  });

  it("refuses root before touching anything", async () => {
    const systemd = new RecordedSystemd(dir);
    const installed = await manager(systemd).install(
      registration({ account: { name: "root", domain: null, uid: 0 } }),
      { start: true, linger: false },
    );
    expect(installed).toMatchObject({
      ok: false,
      problem: expect.stringContaining("never as root"),
    });
    expect(systemd.calls).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
  });

  it("reports the unit's state, pid, restarts and the keeper's own linger", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    expect(await units.status(defaultUnitName)).toEqual({
      installed: false,
      running: false,
      state: "not installed",
      pid: null,
      notes: [],
    });
    await units.install(registration(), { start: true, linger: false });
    expect(await units.status(defaultUnitName)).toEqual({
      installed: true,
      running: true,
      state: "active (running)",
      pid: 4243,
      notes: [
        "unit file enabled, 0 restarts by systemd",
        "linger off: the node stops when you log out (keywork node install --linger keeps it)",
      ],
    });
    expect(systemd.calls.at(-1)).toEqual([
      "loginctl",
      "show-user",
      linuxKeeperName,
      "--property=Linger",
    ]);
  });

  it("reads linger for the keeper, because show-user without a user describes logind itself", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    await units.install(registration(), { start: true, linger: true });
    expect(systemd.calls.at(-1)).toEqual(["loginctl", "enable-linger", linuxKeeperName]);
    expect((await units.status(defaultUnitName)).notes).toContain(
      "linger on: the node keeps running after you log out",
    );
    expect((await systemd.run("loginctl", ["show-user", "--property=Linger"])).stdout).toBe("");
  });

  it("says when systemd gave up after the start limit", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    await units.install(registration(), { start: true, linger: false });
    systemd.hitStartLimit(defaultUnitName);
    expect(await units.status(defaultUnitName)).toEqual({
      installed: true,
      running: false,
      state: "failed (failed)",
      pid: null,
      notes: [
        "unit file enabled, 3 restarts by systemd",
        "systemd stopped restarting it: more than 3 starts in 5 minutes (keywork node reset starts it again)",
        "linger off: the node stops when you log out (keywork node install --linger keeps it)",
      ],
    });
    expect(await units.start(defaultUnitName)).toEqual({
      ok: true,
      did: [`started ${defaultUnitName}`],
    });
    expect(systemd.calls.slice(-2).map((call) => call[2])).toEqual(["reset-failed", "start"]);
  });

  it("stops, disables and removes the unit on uninstall, and says so when there was none", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    expect(await units.uninstall(defaultUnitName)).toEqual({
      ok: true,
      did: [`no user unit ${defaultUnitName} was installed`],
    });
    await units.install(registration(), { start: true, linger: false });
    expect(await units.uninstall(defaultUnitName)).toEqual({
      ok: true,
      did: [
        `stopped and disabled ${defaultUnitName}`,
        `removed ${unitFile()}`,
        "reloaded the user manager",
      ],
    });
    expect(systemd.units.size + systemd.enabled.size).toBe(0);
    expect(existsSync(unitFile())).toBe(false);
    expect(await units.status(defaultUnitName)).toMatchObject({ installed: false });
  });

  it("reads back the program the unit runs, quoting and all, and nothing when there is no unit", async () => {
    const units = manager(new RecordedSystemd(dir));
    expect(await units.program(defaultUnitName)).toBeUndefined();
    const odd = "/opt/my tools/$HOME 100%/keywork";
    await units.install(registration({ launch: { program: odd, args: [] } }), {
      start: false,
      linger: false,
    });
    expect(await units.program(defaultUnitName)).toBe(odd);
    await units.install(registration(), { start: false, linger: false });
    expect(await units.program(defaultUnitName)).toBe(`${home}/.bun/bin/bun`);
  });

  it("starts a stopped unit again without rewriting it", async () => {
    const systemd = new RecordedSystemd(dir);
    const units = manager(systemd);
    await units.install(registration(), { start: true, linger: false });
    const written = readFileSync(unitFile(), "utf8");
    expect(await units.stop(defaultUnitName)).toEqual({
      ok: true,
      did: [`stopped ${defaultUnitName}`],
    });
    expect(await units.start(defaultUnitName)).toEqual({
      ok: true,
      did: [`started ${defaultUnitName}`],
    });
    expect(systemd.calls.slice(-3).map((call) => call[2])).toEqual([
      "stop",
      "reset-failed",
      "start",
    ]);
    expect(readFileSync(unitFile(), "utf8")).toBe(written);
    expect(await units.status(defaultUnitName)).toMatchObject({ running: true });
  });

  it("passes on what systemctl said when it refuses", async () => {
    const systemd = new RecordedSystemd(dir);
    systemd.userBus = false;
    const installed = await manager(systemd).install(registration(), {
      start: true,
      linger: false,
    });
    expect(installed).toEqual({
      ok: false,
      problem:
        "systemctl --user daemon-reload exited 1: Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)",
      did: [`wrote ${unitFile()}`],
    });
  });
});
