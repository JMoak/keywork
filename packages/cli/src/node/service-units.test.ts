import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAgentLabel, launchAgentPlist, launchdAgentManager } from "./launchd.ts";
import type { Registration } from "./manager.ts";
import {
  defaultUnitName,
  systemdArgument,
  systemdUnit,
  systemdUnitDir,
  systemdUserManager,
} from "./systemd.ts";
import { FakeLaunchctl, FakeSystemd, linuxKeeper } from "./testing.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-units-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registration(name: string, overrides: Partial<Registration> = {}): Registration {
  return {
    name,
    launch: {
      program: "/home/keeper/.bun/bin/bun",
      args: ["/home/keeper/src/stead/repos/keywork/packages/cli/src/main.ts"],
    },
    args: ["node", "run", "--supervise"],
    workingDirectory: "/home/keeper/.keywork/node",
    account: linuxKeeper,
    path: "/home/keeper/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    logFile: "/home/keeper/.keywork/node/logs/service.log",
    ...overrides,
  };
}

describe("the systemd user unit", () => {
  const unit = systemdUnit(registration(defaultUnitName));

  it("restarts on failure under a start limit of three in five minutes", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=3");
    expect(unit.indexOf("StartLimitBurst")).toBeLessThan(unit.indexOf("[Service]"));
  });

  it("runs the supervisor as the user with the PATH it was installed with", () => {
    expect(unit).toContain(
      "ExecStart=/home/keeper/.bun/bin/bun /home/keeper/src/stead/repos/keywork/packages/cli/src/main.ts node run --supervise",
    );
    expect(unit).toContain("Environment=PATH=/home/keeper/.bun/bin:/usr/local/bin:/usr/bin:/bin");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).not.toMatch(/^User=|root/m);
  });

  it("quotes and escapes arguments the way systemd reads them", () => {
    expect(systemdArgument("/opt/my tools/bun")).toBe('"/opt/my tools/bun"');
    expect(systemdArgument("100%")).toBe("100%%");
    expect(systemdArgument("$HOME")).toBe("$$HOME");
    const spaced = systemdUnit(registration(defaultUnitName, { path: "/opt/my tools/bin:$X%" }));
    expect(spaced).toContain('Environment="PATH=/opt/my tools/bin:$X%%"');
  });

  it("lives under XDG_CONFIG_HOME when it is set", () => {
    expect(systemdUnitDir("/home/keeper", {})).toBe(
      join("/home/keeper", ".config", "systemd", "user"),
    );
    expect(systemdUnitDir("/home/keeper", { XDG_CONFIG_HOME: "/cfg" })).toBe(
      join("/cfg", "systemd", "user"),
    );
  });
});

describe("the systemd user manager", () => {
  it("writes, enables and starts the unit, and leaves linger alone unless asked", async () => {
    const systemd = new FakeSystemd(dir);
    const units = systemdUserManager({ run: systemd.run, unitDir: dir });
    const installed = await units.install(registration(defaultUnitName), {
      start: true,
      linger: false,
    });
    expect(installed.ok).toBe(true);
    expect(existsSync(join(dir, defaultUnitName))).toBe(true);
    expect(systemd.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", defaultUnitName],
      ["systemctl", "--user", "restart", defaultUnitName],
    ]);
    expect(await units.status(defaultUnitName)).toMatchObject({
      installed: true,
      running: true,
      pid: 4242,
      notes: [expect.stringContaining("enabled"), expect.stringContaining("linger off")],
    });
  });

  it("enables linger only as an explicit opt-in", async () => {
    const systemd = new FakeSystemd(dir);
    const units = systemdUserManager({ run: systemd.run, unitDir: dir });
    await units.install(registration(defaultUnitName), { start: true, linger: true });
    expect(systemd.calls.at(-1)).toEqual(["loginctl", "enable-linger", "keeper"]);
    expect((await units.status(defaultUnitName)).notes).toContain(
      "linger on: the node keeps running after you log out",
    );
  });

  it("refuses root before touching anything", async () => {
    const systemd = new FakeSystemd(dir);
    const units = systemdUserManager({ run: systemd.run, unitDir: dir });
    const installed = await units.install(
      registration(defaultUnitName, { account: { name: "root", domain: null, uid: 0 } }),
      { start: true, linger: false },
    );
    expect(installed).toMatchObject({
      ok: false,
      problem: expect.stringContaining("never as root"),
    });
    expect(systemd.calls).toEqual([]);
    expect(existsSync(join(dir, defaultUnitName))).toBe(false);
  });

  it("stops, disables and removes the unit on uninstall", async () => {
    const systemd = new FakeSystemd(dir);
    const units = systemdUserManager({ run: systemd.run, unitDir: dir });
    await units.install(registration(defaultUnitName), { start: true, linger: false });
    const removed = await units.uninstall(defaultUnitName);
    expect(removed.ok).toBe(true);
    expect(existsSync(join(dir, defaultUnitName))).toBe(false);
    expect(systemd.active.size + systemd.enabled.size).toBe(0);
    expect(await units.status(defaultUnitName)).toMatchObject({ installed: false });
  });
});

describe("the launchd agent", () => {
  const plist = launchAgentPlist(registration(defaultAgentLabel));

  it("keeps the supervisor alive only after a failed exit, throttled, at login", () => {
    expect(plist).toContain(`<key>Label</key>\n  <string>${defaultAgentLabel}</string>`);
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    );
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("    <string>--supervise</string>\n  </array>");
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/home/keeper/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>",
    );
  });

  it("is written to LaunchAgents and bootstrapped into the keeper's GUI domain", async () => {
    const launchctl = new FakeLaunchctl();
    const agents = launchdAgentManager({ run: launchctl.run, agentsDir: dir, uid: 501 });
    const installed = await agents.install(registration(defaultAgentLabel), {
      start: true,
      linger: false,
    });
    expect(installed.ok).toBe(true);
    expect(readFileSync(join(dir, `${defaultAgentLabel}.plist`), "utf8")).toBe(plist);
    expect(launchctl.calls.at(-1)).toEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      join(dir, `${defaultAgentLabel}.plist`),
    ]);
    expect(await agents.status(defaultAgentLabel)).toMatchObject({
      installed: true,
      running: true,
      pid: 501,
    });
    const removed = await agents.uninstall(defaultAgentLabel);
    expect(removed.ok).toBe(true);
    expect(await agents.status(defaultAgentLabel)).toMatchObject({ installed: false });
  });
});
