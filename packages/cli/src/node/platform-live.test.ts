import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentAccount } from "./account.ts";
import { launchdAgentManager } from "./launchd.ts";
import type { Registration, ServiceManager } from "./manager.ts";
import { systemRunner } from "./runner.ts";
import { systemdUnitDir, systemdUserManager } from "./systemd.ts";

const liveOn = (platform: NodeJS.Platform) =>
  process.env.KEYWORK_LIVE_NODE === "1" && process.platform === platform;

describe.skipIf(!liveOn("darwin"))(
  "live: the LaunchAgent on this Mac (KEYWORK_LIVE_NODE=1)",
  () => {
    const label = `dev.stead.keywork-node-live-${process.pid}`;
    let dir: string;
    let agents: ServiceManager;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "keywork-node-live-launchd-"));
      agents = launchdAgentManager({
        run: systemRunner,
        agentsDir: dir,
        uid: currentAccount().uid ?? -1,
      });
    });

    afterAll(async () => {
      await agents.uninstall(label);
      rmSync(dir, { recursive: true, force: true });
    });

    it("bootstraps a KeepAlive agent into the GUI domain, reads it back running, and boots it out", async () => {
      await expectRoundTrip(agents, sleeper(label, dir), "running");
    });
  },
);

describe.skipIf(!liveOn("linux"))(
  "live: the systemd user unit on this machine (KEYWORK_LIVE_NODE=1)",
  () => {
    const name = `keywork-node-live-${process.pid}.service`;
    let dir: string;
    let units: ServiceManager;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "keywork-node-live-systemd-"));
      units = systemdUserManager({
        run: systemRunner,
        unitDir: systemdUnitDir(homedir(), process.env),
      });
    });

    afterAll(async () => {
      await units.uninstall(name);
      rmSync(dir, { recursive: true, force: true });
    });

    it("enables and starts a user unit, reads it back active, and removes it", async () => {
      await expectRoundTrip(units, sleeper(name, dir), "active (running)");
    });
  },
);

async function expectRoundTrip(
  manager: ServiceManager,
  registration: Registration,
  runningState: string,
): Promise<void> {
  const installed = await manager.install(registration, { start: true, linger: false });
  expect(installed).toMatchObject({ ok: true });

  const status = await manager.status(registration.name);
  expect(status).toMatchObject({ installed: true, running: true, state: runningState });
  expect(status.pid).toBeGreaterThan(0);

  const removed = await manager.uninstall(registration.name);
  expect(removed).toMatchObject({ ok: true });
  expect(await manager.status(registration.name)).toMatchObject({
    installed: false,
    running: false,
  });
}

function sleeper(name: string, dir: string): Registration {
  return {
    name,
    launch: { program: "/bin/sleep", args: [] },
    args: ["600"],
    workingDirectory: dir,
    account: currentAccount(),
    path: process.env.PATH,
    logFile: join(dir, "service.log"),
  };
}
