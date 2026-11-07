import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { SandboxHost } from "../sandbox/host.ts";
import type { CliRunner, Invocation, Outcome } from "./runner.ts";
import { displayCommand, qualifiedSbxVersion } from "./sbx.ts";

export const refusingSandboxHost: SandboxHost = {
  platform: "darwin",
  home: "/home/keeper",
  env: {},
  bubblewrap: () => undefined,
  trial: async () => ({ ok: true }),
};

export type FakeStatus = "running" | "stopped" | "running (not responding)" | "starting";

export interface FakeSandbox {
  status: FakeStatus;
  readonly env: Record<string, string>;
  readonly files: Map<string, string>;
  readonly createdWith: Invocation;
}

export interface FakeRule {
  readonly scope: string;
  readonly decision: "allow" | "deny";
  readonly resource: string;
  readonly methods: readonly string[];
}

export interface HeldSecret {
  readonly sandbox: string;
  readonly hosts: readonly string[];
  readonly env: string;
  readonly value: string;
}

export interface FakeSbxOptions {
  readonly version?: string;
  readonly globalAllows?: readonly string[];
  readonly startsAs?: readonly FakeStatus[];
  readonly display?: string;
  readonly refuse?: (args: readonly string[]) => string | undefined;
}

export interface FakeSbx {
  readonly run: CliRunner;
  readonly calls: Invocation[];
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly rules: FakeRule[];
  readonly secrets: HeldSecret[];
  daemonRestarts(): number;
}

export const fakeVersionLine = (version: string): string =>
  `sbx version v${version} (9d79d90ee4c5d297fb3d36b75384e8cea7a4fbcb)\n`;

export function fakeSbx(options: FakeSbxOptions = {}): FakeSbx {
  const calls: Invocation[] = [];
  const sandboxes = new Map<string, FakeSandbox>();
  const rules: FakeRule[] = (options.globalAllows ?? []).map((resource) => ({
    scope: "(global)",
    decision: "allow",
    resource,
    methods: [],
  }));
  const secrets: HeldSecret[] = [];
  const startsAs = [...(options.startsAs ?? [])];
  let restarts = 0;
  let placeholders = 0;

  const commands: Record<string, (args: readonly string[], invocation: Invocation) => Outcome> = {
    version: () => ok(fakeVersionLine(options.version ?? qualifiedSbxVersion)),
    ls: () => ok(listing(sandboxes)),
    policy: (args) => policy(args),
    create: (args, invocation) => {
      const name = valueAfter(args, "--name");
      if (sandboxes.has(name)) return failed(`sandbox ${name} already exists`);
      sandboxes.set(name, {
        status: "stopped",
        env: {},
        files: new Map(),
        createdWith: invocation,
      });
      return ok(`Created sandbox ${name}\n`);
    },
    start: (args) =>
      withSandbox(args[1], (sandbox) => {
        sandbox.status = startsAs.shift() ?? "running";
        return ok("");
      }),
    stop: (args) =>
      withSandbox(args[1], (sandbox) => {
        sandbox.status = "stopped";
        return ok("");
      }),
    rm: (args) => {
      const name = args.at(-1) ?? "";
      return sandboxes.delete(name) ? ok("") : failed(`no sandbox named ${name}`);
    },
    daemon: () => {
      restarts += 1;
      for (const sandbox of sandboxes.values()) sandbox.status = "stopped";
      return ok("");
    },
    secret: (args, invocation) => setCustom(args, invocation),
    exec: (args) => withSandbox(args[1], (sandbox) => exec(sandbox, args.slice(3))),
    cp: (args, invocation) => copy(args, invocation),
  };

  const run: CliRunner = async (invocation) => {
    calls.push(invocation);
    const refusal = options.refuse?.(invocation.args);
    if (refusal !== undefined) return failed(refusal);
    const [command = "", ...rest] = invocation.args;
    const handler = commands[command];
    if (handler === undefined)
      return { code: 2, stdout: "", stderr: `unknown command ${command}`, timedOut: false };
    return handler([command, ...rest], invocation);
  };

  return { run, calls, sandboxes, rules, secrets, daemonRestarts: () => restarts };

  function withSandbox(name: string | undefined, act: (sandbox: FakeSandbox) => Outcome): Outcome {
    const sandbox = sandboxes.get(name ?? "");
    return sandbox === undefined ? failed(`no sandbox named ${name}`) : act(sandbox);
  }

  function policy(args: readonly string[]): Outcome {
    const [, verb, kind] = args;
    if (verb === "ls") return ok(policyListing(rules));
    if ((verb !== "allow" && verb !== "deny") || kind !== "network")
      return failed("unsupported policy command");
    const scope = valueAfter(args, "--sandbox");
    const positional = args
      .slice(5)
      .filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--method");
    const methods = args.flatMap((arg, index) => (args[index - 1] === "--method" ? [arg] : []));
    for (const resource of positional) rules.push({ scope, decision: verb, resource, methods });
    return ok("");
  }

  function setCustom(args: readonly string[], invocation: Invocation): Outcome {
    if (args[1] !== "set-custom" || !args.includes("--value-stdin"))
      return failed("unsupported secret command");
    const sandbox = valueAfter(args, "--sandbox");
    const env = valueAfter(args, "--env");
    const hosts = args.flatMap((arg, index) => (args[index - 1] === "--host" ? [arg] : []));
    secrets.push({ sandbox, hosts, env, value: invocation.input ?? "" });
    const held = sandboxes.get(sandbox);
    if (held !== undefined) {
      placeholders += 1;
      held.env[env] = `sbx-cs-${placeholders.toString(16).padStart(8, "0")}`;
    }
    return ok("");
  }

  function copy(args: readonly string[], invocation: Invocation): Outcome {
    const [, source = "", destination = ""] = args;
    const colon = destination.indexOf(":");
    const sandbox = sandboxes.get(destination.slice(0, colon));
    if (sandbox === undefined) return failed(`no sandbox in ${destination}`);
    const content = readFileSync(join(invocation.cwd ?? ".", source), "utf8");
    sandbox.files.set(destination.slice(colon + 1), content);
    return ok("");
  }

  function exec(sandbox: FakeSandbox, argv: readonly string[]): Outcome {
    if (sandbox.status !== "running") return failed("sandbox is not running");
    const entered = argv[0] === "sh" && argv[1] === "-c" && argv[3] === "workshop";
    const cwd = entered ? (argv[4] ?? "/") : "/";
    const command = entered ? argv.slice(5) : argv;
    if (command.join(" ") === displayCommand.join(" ")) {
      return options.display === undefined
        ? { ...failed(""), code: 3 }
        : ok(`${options.display}\n`);
    }
    if (command[0] === "sh" && command[1] === "-c") return script(sandbox, cwd, command[2] ?? "");
    return program(sandbox, cwd, command);
  }

  function script(sandbox: FakeSandbox, cwd: string, text: string): Outcome {
    const words = text.trim().split(/\s+/);
    if (words[0] === "exit")
      return { code: Number(words[1] ?? 0), stdout: "", stderr: "", timedOut: false };
    if (words[0] === "echo") return ok(`${words.slice(1).join(" ")}\n`);
    return program(sandbox, cwd, words);
  }

  function program(sandbox: FakeSandbox, cwd: string, command: readonly string[]): Outcome {
    const [name, ...args] = command;
    switch (name) {
      case "pwd":
        return ok(`${cwd}\n`);
      case "env":
        return ok(
          Object.entries(sandbox.env)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
        );
      case "printenv": {
        const value = sandbox.env[args[0] ?? ""];
        return value === undefined ? { ...failed(""), code: 1 } : ok(`${value}\n`);
      }
      case "mkdir":
        return ok("");
      case "df":
        return ok(fakeDiskFree(args.at(-1) ?? "/"));
      case "cat": {
        const path = posix.resolve(cwd, args.filter((arg) => arg !== "--")[0] ?? "");
        if (path === "/proc/meminfo") return ok(fakeMeminfo);
        const content = sandbox.files.get(path);
        return content === undefined
          ? failed(`cat: ${path}: No such file or directory`)
          : ok(content);
      }
      default:
        return failed(`${name}: command not found`);
    }
  }
}

export const fakeMeminfo =
  "MemTotal:        4028736 kB\nMemFree:          912344 kB\nMemAvailable:    3004736 kB\n";

export function fakeDiskFree(path: string): string {
  return `Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/vda1         20511312 1048576  19462736       6% ${path}\n`;
}

function listing(sandboxes: Map<string, FakeSandbox>): string {
  const rows = [...sandboxes].map(([name, sandbox]) =>
    table([name, "stead-workshop", statusCell(sandbox.status), "", "", "1m"]),
  );
  return lines([table(["SANDBOX", "AGENT", "STATUS", "PORTS", "WORKSPACE", "CREATED"]), ...rows]);
}

function statusCell(status: FakeStatus): string {
  return status === "stopped" ? "○ stopped" : `● ${status}`;
}

function policyListing(rules: readonly FakeRule[]): string {
  const rows = rules.map((rule) => table([rule.scope, "network", rule.decision, rule.resource]));
  return lines([table(["SCOPE", "TYPE", "DECISION", "RESOURCES"]), ...rows]);
}

function table(cells: readonly string[]): string {
  return cells
    .map((cell) => cell.padEnd(12))
    .join("  ")
    .trimEnd();
}

function lines(rows: readonly string[]): string {
  return `${rows.join("\n")}\n`;
}

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? "" : (args[index + 1] ?? "");
}

function ok(stdout: string): Outcome {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function failed(stderr: string): Outcome {
  return { code: 1, stdout: "", stderr, timedOut: false };
}
