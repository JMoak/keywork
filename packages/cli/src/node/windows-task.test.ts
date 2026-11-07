import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Registration } from "./manager.ts";
import { FakeSchtasks, keeper } from "./testing.ts";
import { defaultTaskName, taskXml, windowsArgument, windowsTaskManager } from "./windows-task.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-task-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    name: defaultTaskName,
    launch: {
      program: "C:\\Program Files\\bun\\bun.exe",
      args: ["C:\\src\\stead\\repos\\keywork\\packages\\cli\\src\\main.ts"],
    },
    args: ["node", "run", "--supervise", "--hidden"],
    workingDirectory: "C:\\Users\\moakj\\.keywork\\node",
    account: keeper,
    path: undefined,
    logFile: "C:\\Users\\moakj\\.keywork\\node\\logs\\service.log",
    ...overrides,
  };
}

function manager(schtasks: FakeSchtasks) {
  return windowsTaskManager({ run: schtasks.run, definitionFile: join(dir, "task.xml") });
}

describe("the logon task definition", () => {
  const xml = taskXml(registration());

  it("runs at the keeper's own logon with the interactive token and least privilege", () => {
    expect(xml).toContain(
      "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>MOAK-MAIN\\moakj</UserId>",
    );
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toMatch(/S4U|Password|HighestAvailable|S-1-5-18|SYSTEM/);
  });

  it("never times out, never runs twice and is restarted by Task Scheduler if the supervisor itself fails", () => {
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain(
      "<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>3</Count>",
    );
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
  });

  it("launches the supervisor with every argument quoted the way Windows splits them", () => {
    expect(xml).toContain("<Command>C:\\Program Files\\bun\\bun.exe</Command>");
    expect(xml).toContain(
      "<Arguments>C:\\src\\stead\\repos\\keywork\\packages\\cli\\src\\main.ts node run --supervise --hidden</Arguments>",
    );
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\moakj\\.keywork\\node</WorkingDirectory>");
  });

  it("escapes what XML cannot carry", () => {
    const odd = taskXml(
      registration({ launch: { program: "C:\\A&B <tools>\\bun.exe", args: [] } }),
    );
    expect(odd).toContain("<Command>C:\\A&amp;B &lt;tools&gt;\\bun.exe</Command>");
  });
});

describe("windowsArgument", () => {
  it("follows the CommandLineToArgvW rules", () => {
    expect(windowsArgument("plain")).toBe("plain");
    expect(windowsArgument("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(windowsArgument("")).toBe('""');
  });
});

describe("the Windows task manager", () => {
  it("writes the definition as UTF-16 with a byte order mark, registers it and starts it", async () => {
    const schtasks = new FakeSchtasks();
    const installed = await manager(schtasks).install(registration(), {
      start: true,
      linger: false,
    });
    expect(installed.ok).toBe(true);
    const bytes = readFileSync(join(dir, "task.xml"));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(schtasks.verbs()).toEqual(["/Create", "/Run"]);
    expect(schtasks.calls[0]).toEqual([
      "schtasks",
      "/Create",
      "/TN",
      "keywork node",
      "/XML",
      join(dir, "task.xml"),
      "/F",
    ]);
    expect(schtasks.tasks.get("keywork node")?.state).toBe("Running");
  });

  it("registers without starting when asked not to start", async () => {
    const schtasks = new FakeSchtasks();
    await manager(schtasks).install(registration(), { start: false, linger: false });
    expect(schtasks.verbs()).toEqual(["/Create"]);
    expect(schtasks.tasks.get("keywork node")?.state).toBe("Ready");
  });

  it("refuses to register a task for SYSTEM", async () => {
    const schtasks = new FakeSchtasks();
    const installed = await manager(schtasks).install(
      registration({ account: { name: "SYSTEM", domain: "NT AUTHORITY", uid: null } }),
      { start: true, linger: false },
    );
    expect(installed).toMatchObject({
      ok: false,
      problem: expect.stringContaining("never as SYSTEM"),
    });
    expect(schtasks.calls).toEqual([]);
  });

  it("reports the task's state and logon type", async () => {
    const schtasks = new FakeSchtasks();
    const tasks = manager(schtasks);
    expect(await tasks.status(defaultTaskName)).toMatchObject({ installed: false, running: false });
    await tasks.install(registration(), { start: true, linger: false });
    expect(await tasks.status(defaultTaskName)).toEqual({
      installed: true,
      running: true,
      state: "Running",
      pid: null,
      notes: ["logon type InteractiveToken, run level LeastPrivilege"],
    });
  });

  it("ends and deletes the task on uninstall, and says so when there was none", async () => {
    const schtasks = new FakeSchtasks();
    const tasks = manager(schtasks);
    expect(await tasks.uninstall(defaultTaskName)).toEqual({
      ok: true,
      did: ['no logon task named "keywork node" was registered'],
    });
    await tasks.install(registration(), { start: true, linger: false });
    const removed = await tasks.uninstall(defaultTaskName);
    expect(removed.did).toEqual([
      'ended the running task "keywork node"',
      'removed the logon task "keywork node"',
    ]);
    expect(schtasks.tasks.size).toBe(0);
  });

  it("reads back the program the registered task runs, and nothing when there is no task", async () => {
    const schtasks = new FakeSchtasks();
    const tasks = manager(schtasks);
    expect(await tasks.program(defaultTaskName)).toBeUndefined();
    const sidecar = "C:\\Users\\moakj\\AppData\\Local\\Programs\\A&B stead\\sidecar\\keywork.exe";
    await tasks.install(registration({ launch: { program: sidecar, args: [] } }), {
      start: false,
      linger: false,
    });
    expect(await tasks.program(defaultTaskName)).toBe(sidecar);
  });

  it("ends a running task and runs it again without registering it anew", async () => {
    const schtasks = new FakeSchtasks();
    const tasks = manager(schtasks);
    await tasks.install(registration(), { start: true, linger: false });
    const registered = schtasks.tasks.get(defaultTaskName)?.xml;
    expect(await tasks.stop(defaultTaskName)).toEqual({
      ok: true,
      did: ['ended the running task "keywork node"'],
    });
    expect(await tasks.start(defaultTaskName)).toEqual({
      ok: true,
      did: ['started the task "keywork node"'],
    });
    expect(schtasks.verbs()).toEqual(["/Create", "/Run", "/End", "/Run"]);
    expect(schtasks.tasks.get(defaultTaskName)).toEqual({ xml: registered, state: "Running" });
  });

  it("passes on what schtasks said when it refuses", async () => {
    const schtasks = new FakeSchtasks();
    const started = await manager(schtasks).start("missing task");
    expect(started).toMatchObject({
      ok: false,
      problem:
        "schtasks /Run /TN missing task exited 1: ERROR: The system cannot find the file specified.",
    });
  });
});
