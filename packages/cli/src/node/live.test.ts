import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentAccount } from "./account.ts";
import { supervisorArgs } from "./launch.ts";
import type { ServiceManager } from "./manager.ts";
import { systemRunner } from "./runner.ts";
import { windowsTaskManager } from "./windows-task.ts";

const live = process.env.KEYWORK_LIVE_NODE === "1" && process.platform === "win32";

describe.skipIf(!live)("live: the logon task on this machine (KEYWORK_LIVE_NODE=1)", () => {
  const name = `keywork node live-test ${process.pid}`;
  let dir: string;
  let tasks: ServiceManager;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "keywork-node-live-"));
    tasks = windowsTaskManager({ run: systemRunner, definitionFile: join(dir, "task.xml") });
  });

  afterAll(async () => {
    await systemRunner("schtasks", ["/Delete", "/TN", name, "/F"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a logon task with the interactive token for the signed-in user, then removes it", async () => {
    const account = currentAccount();
    const installed = await tasks.install(
      {
        name,
        launch: { program: process.execPath, args: [join(import.meta.dirname, "..", "main.ts")] },
        args: [...supervisorArgs, "--hidden"],
        workingDirectory: dir,
        account,
        path: undefined,
        logFile: join(dir, "service.log"),
      },
      { start: false, linger: false },
    );
    expect(installed).toMatchObject({ ok: true });

    const status = await tasks.status(name);
    expect(status).toMatchObject({ installed: true, running: false });
    expect(status.notes).toEqual(["logon type InteractiveToken, run level LeastPrivilege"]);

    const definition = await systemRunner("schtasks", ["/Query", "/TN", name, "/XML"]);
    expect(definition.stdout).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition.stdout).toMatch(/<UserId>S-1-5-21-[\d-]+<\/UserId>/);
    expect(definition.stdout).not.toMatch(/S-1-5-18|HighestAvailable|S4U|Password/);
    expect(definition.stdout).toContain("node run --supervise --hidden");

    const removed = await tasks.uninstall(name);
    expect(removed).toMatchObject({ ok: true });
    expect(await tasks.status(name)).toMatchObject({ installed: false });
  });
});
