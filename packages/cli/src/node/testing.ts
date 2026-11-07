import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Account } from "./account.ts";
import type { CommandRunner, Ran } from "./runner.ts";
import type {
  ChildExit,
  LineListener,
  OutputStream,
  ProcessSpawner,
  SupervisedChild,
  UnitSpec,
} from "./supervisor.ts";

export const keeper: Account = { name: "moakj", domain: "MOAK-MAIN", uid: null };
export const linuxKeeper: Account = { name: "keeper", domain: null, uid: 1000 };

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await flush();
}

export class FakeChild implements SupervisedChild {
  readonly exited: Promise<ChildExit>;
  stopRequests = 0;
  killed = false;
  exitsOnStop = true;
  private finish: (exit: ChildExit) => void = () => {};
  private done = false;

  constructor(
    readonly unit: UnitSpec,
    readonly pid: number,
    private readonly onLine: LineListener,
  ) {
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  get running(): boolean {
    return !this.done;
  }

  say(line: string, stream: OutputStream = "stdout"): void {
    this.onLine(stream, line);
  }

  crash(code = 1): void {
    this.end({ code, signal: null });
  }

  stop(): void {
    this.stopRequests += 1;
    if (this.exitsOnStop) this.end({ code: 0, signal: null });
  }

  kill(): void {
    this.killed = true;
    this.end({ code: null, signal: "SIGKILL" });
  }

  private end(exit: ChildExit): void {
    if (this.done) return;
    this.done = true;
    this.finish(exit);
  }
}

export class FakeProcesses {
  readonly spawned: FakeChild[] = [];
  refuse: string | undefined;
  private nextPid = 4100;

  readonly spawn: ProcessSpawner = (unit, onLine) => {
    if (this.refuse !== undefined) throw new Error(this.refuse);
    const child = new FakeChild(unit, this.nextPid, onLine);
    this.nextPid += 1;
    this.spawned.push(child);
    return child;
  };

  of(unit: string): FakeChild[] {
    return this.spawned.filter((child) => child.unit.name === unit);
  }

  latest(unit: string): FakeChild {
    const child = this.of(unit).at(-1);
    if (child === undefined) throw new Error(`${unit} never started`);
    return child;
  }

  live(): FakeChild[] {
    return this.spawned.filter((child) => child.running);
  }
}

export function ok(stdout = ""): Ran {
  return { code: 0, stdout, stderr: "" };
}

export function failed(code: number, stderr: string): Ran {
  return { code, stdout: "", stderr };
}

export class FakeSchtasks {
  readonly tasks = new Map<string, { xml: string; state: "Ready" | "Running" }>();
  readonly calls: string[][] = [];

  readonly run: CommandRunner = async (program, args) => {
    this.calls.push([program, ...args]);
    if (program !== "schtasks") return failed(127, `${program} is not on PATH`);
    const name = valueAfter(args, "/TN");
    const task = this.tasks.get(name);
    switch (args[0]) {
      case "/Create":
        this.tasks.set(name, { xml: utf16File(valueAfter(args, "/XML")), state: "Ready" });
        return ok(`SUCCESS: The scheduled task "${name}" has successfully been created.`);
      case "/Query":
        if (task === undefined)
          return failed(1, "ERROR: The system cannot find the file specified.");
        if (args.includes("/XML")) return ok(task.xml);
        return ok(`"\\${name}","N/A","${task.state}"\r\n`);
      case "/Run":
        if (task === undefined)
          return failed(1, "ERROR: The system cannot find the file specified.");
        task.state = "Running";
        return ok(`SUCCESS: Attempted to run the scheduled task "${name}".`);
      case "/End":
        if (task?.state !== "Running")
          return failed(1, `ERROR: The task "${name}" is not running.`);
        task.state = "Ready";
        return ok(`SUCCESS: The scheduled task "${name}" was terminated successfully.`);
      case "/Delete":
        if (task === undefined)
          return failed(1, "ERROR: The system cannot find the file specified.");
        this.tasks.delete(name);
        return ok(`SUCCESS: The scheduled task "${name}" was successfully deleted.`);
      default:
        return failed(1, `ERROR: Invalid argument/option - '${args[0]}'.`);
    }
  };

  verbs(): string[] {
    return this.calls.map((call) => call[1] ?? "");
  }
}

export class FakeSystemd {
  readonly calls: string[][] = [];
  readonly enabled = new Set<string>();
  readonly active = new Set<string>();
  readonly lingering = new Set<string>();

  constructor(private readonly unitDir: string) {}

  readonly run: CommandRunner = async (program, args) => {
    this.calls.push([program, ...args]);
    if (program === "loginctl") return this.loginctl(args);
    if (program !== "systemctl" || args[0] !== "--user")
      return failed(127, `${program}: unexpected`);
    const [verb, ...rest] = args.slice(1);
    const name = rest.find((word) => word.endsWith(".service")) ?? "";
    const present = existsSync(join(this.unitDir, name));
    switch (verb) {
      case "daemon-reload":
      case "reset-failed":
        return ok();
      case "enable":
        if (!present) return failed(1, `Failed to enable unit: Unit file ${name} does not exist.`);
        this.enabled.add(name);
        return ok();
      case "start":
      case "restart":
        if (!present) return failed(5, `Failed to start ${name}: Unit ${name} not found.`);
        this.active.add(name);
        return ok();
      case "stop":
        this.active.delete(name);
        return ok();
      case "disable":
        this.enabled.delete(name);
        if (rest.includes("--now")) this.active.delete(name);
        return ok();
      case "show":
        return ok(this.shown(name, present));
      default:
        return failed(1, `Unknown command verb ${verb}.`);
    }
  };

  private shown(name: string, present: boolean): string {
    if (!present) return "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n";
    const active = this.active.has(name);
    return [
      "LoadState=loaded",
      `ActiveState=${active ? "active" : "inactive"}`,
      `SubState=${active ? "running" : "dead"}`,
      `UnitFileState=${this.enabled.has(name) ? "enabled" : "disabled"}`,
      `MainPID=${active ? 4242 : 0}`,
      "NRestarts=0",
      "",
    ].join("\n");
  }

  private loginctl(args: readonly string[]): Ran {
    if (args[0] === "enable-linger" && args[1] !== undefined) {
      this.lingering.add(args[1]);
      return ok();
    }
    if (args[0] === "show-user") return ok(`Linger=${this.lingering.size > 0 ? "yes" : "no"}\n`);
    return failed(1, "loginctl: unexpected");
  }
}

export class FakeLaunchctl {
  readonly calls: string[][] = [];
  readonly loaded = new Set<string>();

  readonly run: CommandRunner = async (program, args) => {
    this.calls.push([program, ...args]);
    const [verb, target = ""] = args;
    const label =
      verb === "bootstrap" ? basename(args[2] ?? "", ".plist") : (target.split("/").at(-1) ?? "");
    switch (verb) {
      case "bootstrap":
        this.loaded.add(label);
        return ok();
      case "bootout":
        if (!this.loaded.delete(label)) return failed(3, "Boot-out failed: 3: No such process");
        return ok();
      case "kickstart":
        return this.loaded.has(args[2]?.split("/").at(-1) ?? "")
          ? ok()
          : failed(113, "Could not find service");
      case "print":
        return this.loaded.has(label)
          ? ok(`${target} = {\n\tstate = running\n\tpid = 501\n\tlast exit code = 0\n}\n`)
          : failed(113, `Could not find service "${label}" in domain`);
      default:
        return failed(64, "Unrecognized subcommand");
    }
  };
}

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? "" : (args[index + 1] ?? "");
}

function utf16File(file: string): string {
  const bytes = readFileSync(file);
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe)
    throw new Error(`${file} has no UTF-16LE byte order mark`);
  return bytes.subarray(2).toString("utf16le");
}
