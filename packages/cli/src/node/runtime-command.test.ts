import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeOwnership, type ManagedRuntime, RuntimeRegistry } from "@keywork/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { managedHomeFolder, prepareManagedHome } from "../paths.ts";
import { nodeCommand } from "./command.ts";
import { readNodeConfig, writeNodeConfig } from "./config.ts";
import type { NodeCommandDeps } from "./deps.ts";
import { managed, refused, type ServiceManager } from "./manager.ts";
import { nodePaths } from "./paths.ts";
import { runtimeCommand } from "./runtime-command.ts";
import { keeper } from "./testing.ts";
import { workspaceUnit } from "./units.ts";

const now = 1_000_000;
let root: string;
let folder: string;
let artifact: ManagedRuntime;
let deps: Partial<NodeCommandDeps>;
let operations: string[];
let authorizedWork: boolean;
let staged: number;
let out: string[];
let errors: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-runtime-command-"));
  folder = join(root, "project");
  mkdirSync(folder);
  const binary = join(root, "verified-test-engine.exe");
  writeFileSync(binary, "source-only test seam");
  artifact = {
    version: "0.2.0",
    contract: "1.25",
    binary,
    sha256: createHash("sha256").update("source-only test seam").digest("hex"),
    platform: "win32",
    arch: "x64",
  };
  operations = [];
  authorizedWork = false;
  staged = 0;
  out = [];
  errors = [];
  let installed = false;
  let running = false;
  let program: string | undefined;
  const manager: ServiceManager = {
    kind: "windows-task",
    defaultName: "isolated-runtime",
    describe: () => "test runtime",
    status: async () => ({
      installed,
      running,
      state: running ? "running" : "stopped",
      pid: null,
      notes: [],
    }),
    program: async () => program,
    install: async (registration, choices) => {
      operations.push("install");
      program = registration.launch.program;
      installed = true;
      running = choices.start;
      return managed([]);
    },
    uninstall: async () => {
      operations.push("uninstall");
      installed = false;
      running = false;
      program = undefined;
      return managed([]);
    },
    start: async () => {
      operations.push("start");
      running = true;
      return managed([]);
    },
    stop: async () => {
      operations.push("stop");
      running = false;
      return managed([]);
    },
  };
  deps = {
    userRoot: root,
    cwd: folder,
    platform: "win32",
    account: keeper,
    manager,
    clock: new FakeClock(now),
    version: artifact.version,
    launch: { program: binary, args: [] },
    isAlive: (pid) => pid === 101 || pid === 202,
    workspaceProblem: () => undefined,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("product runtime lifecycle", () => {
  it("opts in per client and reuses a running same-contract engine from a newer bundle", async () => {
    await compatibleInstall();
    const original = artifact;
    useCandidate("0.3.0");
    expect(await compatibleInstall("stead", "b")).toBe(0);
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
      kind: "attached",
      runtime: original,
      deferred: { version: "0.3.0", reason: "runtime-running" },
    });
    expect(
      await run([
        "client",
        "attach",
        folder,
        "--client",
        "new",
        "--console",
        "101",
        "--contract",
        artifact.contract,
      ]),
    ).toBe(0);
    expect((await inspect()).clients[0]).toMatchObject({
      version: "0.3.0",
      compatibility: "contract",
    });
    expect(operations).toEqual(["install", "start"]);
  });

  it("does not reinterpret a legacy installed consumer as contract-compatible", async () => {
    await install();
    useCandidate("0.3.0");
    expect(await compatibleInstall("stead", "b")).toBe(0);
    expect(JSON.parse(out.at(-1) ?? "{}").deferred.reason).toBe("consumer-conflict");
    expect((await inspect()).consumers[0]?.compatibility).toBeUndefined();
    expect(operations).toEqual(["install", "start"]);
  });

  it("activates forward after explicit stop while preserving compatible products and served homes", async () => {
    await compatibleInstall();
    await compatibleInstall("stead", "b");
    const home = prepareManagedHome(root);
    const config = nodePaths(root).config;
    writeNodeConfig(config, {
      ...readNodeConfig(config),
      workspaces: [{ cwd: home, slug: null, home: true }],
    });
    const history = join(home, "history.jsonl");
    writeFileSync(history, "retained\n");
    useCandidate("0.3.0");
    expect(await run(["stop"])).toBe(0);
    expect(await compatibleInstall()).toBe(0);
    expect((await inspect()).runtime).toEqual(artifact);
    expect((await inspect()).consumers).toHaveLength(2);
    expect(readNodeConfig(config).workspaces).toEqual([{ cwd: home, slug: null, home: true }]);
    expect(readFileSync(history, "utf8")).toBe("retained\n");
    expect(operations).toEqual(["install", "start", "stop", "uninstall", "install", "start"]);
  });

  it("never downgrades for an older contract-aware bundle", async () => {
    const older = artifact;
    useCandidate("0.3.0");
    await compatibleInstall();
    const selected = artifact;
    artifact = older;
    deps.version = older.version;
    expect(await compatibleInstall("stead", "b")).toBe(0);
    expect((await inspect()).runtime).toEqual(selected);
    expect(operations).toEqual(["install", "start"]);
  });

  it("blocks legacy service installation and wrong executable launch around a managed selection", async () => {
    await compatibleInstall();
    useCandidate("0.3.0");
    const io = {
      print: (line: string) => out.push(line),
      printError: (line: string) => errors.push(line),
    };
    expect(await nodeCommand(["install"], deps, io)).toBe(3);
    expect(errors.at(-1)).toContain("use node consumer install");
    expect(await nodeCommand(["run", "--supervise"], deps, io)).toBe(3);
    expect(errors.at(-1)).toContain("only the selected managed artifact");
    expect(operations).toEqual(["install", "start"]);
    expect(existsSync(nodePaths(root).config)).toBe(false);
  });

  it("refuses a requested wire contract the bundled bootstrap cannot speak", async () => {
    expect(await run(["consumer", "install", "--installation", "a", "--contract", "2.0"])).toBe(3);
    expect(errors.at(-1)).toContain("bootstrap speaks contract");
    expect(staged).toBe(0);
    expect(operations).toEqual([]);
  });

  it("repairs a failed OS registration forward even when its file already names the candidate", async () => {
    await compatibleInstall();
    const older = artifact;
    await run(["stop"]);
    useCandidate("0.3.0");
    const selected = artifact;
    const manager = requiredManager();
    const installRegistration = manager.install;
    manager.install = async (registration, choices) => {
      await installRegistration(registration, choices);
      return refused("daemon reload failed after writing the unit file");
    };
    expect(await compatibleInstall()).toBe(3);
    expect((await inspect()).runtime).toEqual(older);
    expect((await inspect()).pending?.runtime).toEqual(selected);
    expect(await attach("held", "keywork", 101)).toBe(3);
    manager.install = installRegistration;
    artifact = older;
    deps.version = older.version;
    expect(await compatibleInstall()).toBe(0);
    expect((await inspect()).runtime).toEqual(selected);
    expect((await inspect()).pending).toBeUndefined();
    expect(operations.filter((operation) => operation === "install")).toHaveLength(3);
    expect(await manager.program(manager.defaultName)).toBe(selected.binary);
  });

  it("retains the newer selection after a start failure and retries it from an older bundle", async () => {
    await compatibleInstall();
    const older = artifact;
    await run(["stop"]);
    useCandidate("0.3.0");
    const selected = artifact;
    const manager = requiredManager();
    const start = manager.start;
    manager.start = async () => refused("start failed");
    expect(await compatibleInstall()).toBe(3);
    expect((await inspect()).runtime).toEqual(selected);
    expect((await inspect()).pending).toBeUndefined();
    expect(await manager.program(manager.defaultName)).toBe(selected.binary);
    manager.start = start;
    artifact = older;
    deps.version = older.version;
    expect(await compatibleInstall()).toBe(0);
    expect((await inspect()).runtime).toEqual(selected);
  });

  it("does not mistake a service-manager stop acknowledgement for stopped processes", async () => {
    await compatibleInstall();
    requiredManager().stop = async () => managed([]);
    expect(await run(["stop"])).toBe(3);
    expect(errors.at(-1)).toContain("runtime-running");
    expect((await inspect()).consumers).toHaveLength(1);
  });

  it("will not replace a stopped service while a recorded child or ownership lease survives", async () => {
    await compatibleInstall();
    const original = artifact;
    await run(["stop"]);
    useCandidate("0.3.0");
    const ownership = await acquireRuntimeOwnership(nodePaths(root).ownership);
    if (ownership === undefined) throw new Error("Missing test ownership");
    try {
      expect(await compatibleInstall()).toBe(3);
      expect((await inspect()).runtime).toEqual(original);
      expect((await inspect()).pending).toBeUndefined();
    } finally {
      ownership.release();
    }
    writeFileSync(
      nodePaths(root).nodeFile,
      JSON.stringify({ schema: 1, pid: null, core: { pid: 303 }, workspaces: [] }),
    );
    deps.isAlive = (pid) => pid === 303;
    expect(await compatibleInstall()).toBe(3);
    expect((await inspect()).runtime).toEqual(original);
    expect(operations).toEqual(["install", "start", "stop"]);
  });
  it("attaches a private home before a project and preserves its node launch mode", async () => {
    await install();
    expect(
      await run([
        "client",
        "attach",
        "--home",
        "--product",
        "stead",
        "--client",
        "home",
        "--console",
        "101",
      ]),
    ).toBe(0);
    const workspace = readNodeConfig(nodePaths(root).config).workspaces[0];
    expect(workspace).toEqual({ cwd: managedHomeFolder(root), slug: null, home: true });
    if (workspace === undefined) throw new Error("The private home was not registered");
    const unit = workspaceUnit(workspace, { program: artifact.binary, args: [] }, root, fetch);
    expect(unit.spec.argv).toContain("--home");
    expect(unit.spec.cwd).toBe(managedHomeFolder(root));
  });

  it("refuses replacing the private home with the user profile", async () => {
    await install();
    expect(
      await run(["client", "attach", root, "--home", "--client", "home", "--console", "101"]),
    ).toBe(3);
    expect(existsSync(managedHomeFolder(root))).toBe(false);
    expect((await inspect()).clients).toEqual([]);
  });

  it("checks compatibility before preparing even the private home", async () => {
    await install();
    deps.version = "0.3.0";
    expect(await run(["client", "attach", "--home", "--client", "home", "--console", "101"])).toBe(
      3,
    );
    expect(existsSync(managedHomeFolder(root))).toBe(false);
  });

  it("serializes simultaneous product installs and registers one service", async () => {
    const codes = await Promise.all([
      run(["consumer", "install", "--product", "keywork", "--installation", "a"]),
      run(["consumer", "install", "--product", "stead", "--installation", "b"]),
    ]);
    expect(codes).toEqual([0, 0]);
    expect(operations).toEqual(["install", "start"]);
    expect((await inspect()).consumers.map((consumer) => consumer.id)).toEqual([
      "keywork:a",
      "stead:b",
    ]);
  });

  it("keeps two clients independent and detaches one without stopping the runtime", async () => {
    await install();
    expect(await attach("one", "keywork", 101)).toBe(0);
    expect(await attach("two", "stead", 202)).toBe(0);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toHaveLength(1);
    expect((await inspect()).clients.map((client) => client.id)).toEqual(["one", "two"]);
    expect(await run(["client", "detach", "--client", "one"])).toBe(0);
    expect((await inspect()).clients.map((client) => client.id)).toEqual(["two"]);
    expect(operations).toEqual(["install", "start"]);
  });

  it("rejects incompatible attachment before changing project configuration", async () => {
    await install();
    deps.version = "0.3.0";
    expect(await attach("one", "keywork", 101)).toBe(3);
    expect(existsSync(nodePaths(root).config)).toBe(false);
    expect((await inspect()).clients).toEqual([]);
    expect(errors.at(-1)).toContain("incompatible-runtime");
  });

  it("rejects an incompatible engine update before staging or mutating consumers", async () => {
    await install();
    const before = staged;
    deps.version = "0.3.0";
    expect(await run(["consumer", "install", "--product", "stead", "--installation", "b"])).toBe(3);
    expect(staged).toBe(before);
    expect((await inspect()).consumers.map((consumer) => consumer.id)).toEqual(["keywork:a"]);
    expect(operations).toEqual(["install", "start"]);
    expect(errors.at(-1)).toContain("consumer-conflict");
  });

  it("removes one durable consumer while preserving another", async () => {
    await install();
    await run(["consumer", "install", "--product", "stead", "--installation", "b"]);
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect((await inspect()).consumers.map((consumer) => consumer.id)).toEqual(["stead:b"]);
    expect(operations).toEqual(["install", "start"]);
    expect(JSON.parse(out.at(-1) ?? "{}").kind).toBe("retained");
  });

  it("retains authorized work after the final product is uninstalled", async () => {
    await install();
    authorizedWork = true;
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect((await inspect()).consumers).toEqual([]);
    expect(operations).toEqual(["install", "start"]);
    expect(JSON.parse(out.at(-1) ?? "{}").reasons).toEqual(["work"]);
  });

  it("does not treat an absent consumer or historical marker as service ownership", async () => {
    await install();
    expect(
      await run(["consumer", "remove", "--product", "stead", "--installation", "missing"]),
    ).toBe(0);
    expect(operations).toEqual(["install", "start"]);
    expect(JSON.parse(out.at(-1) ?? "{}").kind).toBe("absent");
  });

  it("removes the service only after the final idle consumer is removed", async () => {
    await install();
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect(operations).toEqual(["install", "start", "uninstall"]);
  });

  it("upgrades a retained home only after explicit workspace removal and preserves its files", async () => {
    await install();
    await run(["consumer", "install", "--product", "stead", "--installation", "b"]);
    const home = prepareManagedHome(root);
    const history = join(home, "preserved-history.jsonl");
    const contents = '{"creature":"pip","history":"retained"}\n';
    writeFileSync(history, contents);
    const configFile = nodePaths(root).config;
    writeNodeConfig(configFile, {
      ...readNodeConfig(configFile),
      workspaces: [{ cwd: home, slug: null, home: true }],
    });
    for (const [product, installation] of [
      ["keywork", "a"],
      ["stead", "b"],
    ] as const) {
      expect(
        await run(
          ["consumer", "remove", "--product", product, "--installation", installation],
          true,
        ),
      ).toBe(0);
    }
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({ kind: "retained", reasons: ["work"] });
    expect((await inspect()).consumers).toEqual([]);

    const binary = join(root, "verified-updated-engine.exe");
    writeFileSync(binary, "updated source-only test seam");
    artifact = {
      ...artifact,
      version: "0.3.0",
      contract: "1.26",
      binary,
      sha256: createHash("sha256").update("updated source-only test seam").digest("hex"),
    };
    deps.version = artifact.version;
    const registration = ["consumer", "install", "--product", "keywork", "--installation", "a"];
    expect(await run(registration, true)).toBe(3);
    expect(errors.at(-1)).toContain("runtime-running");
    expect(operations).toEqual(["install", "start"]);

    expect(
      await nodeCommand(["workspace", "remove", home], deps, {
        print: (line) => out.push(line),
        printError: (line) => errors.push(line),
      }),
    ).toBe(0);
    expect(readNodeConfig(configFile).workspaces).toEqual([]);
    expect(await run(["stop"])).toBe(0);
    expect(await run(registration, true)).toBe(0);
    expect(
      await run(["consumer", "install", "--product", "stead", "--installation", "b"], true),
    ).toBe(0);
    expect(operations).toEqual(["install", "start", "stop", "uninstall", "install", "start"]);
    const updated = await inspect();
    expect(updated.runtime).toEqual(artifact);
    expect(updated.consumers.map((consumer) => [consumer.product, consumer.version])).toEqual([
      ["keywork", "0.3.0"],
      ["stead", "0.3.0"],
    ]);
    expect(readFileSync(history, "utf8")).toBe(contents);
    expect(prepareManagedHome(root)).toBe(home);
  });
});

function run(args: string[], probeWork = false): Promise<number> {
  return runtimeCommand(
    [...args, "--json"],
    deps,
    { print: (line) => out.push(line), printError: (line) => errors.push(line) },
    {
      stage: async () => {
        staged += 1;
        return artifact;
      },
      ...(probeWork ? {} : { authorizedWork: async () => authorizedWork }),
      ready: async (_deps, _paths, runtime) => {
        const manager = deps.manager;
        if (manager === undefined) return false;
        return (
          (await manager.status(manager.defaultName)).running &&
          (await manager.program(manager.defaultName)) === runtime.binary
        );
      },
      contract: artifact.contract,
    },
  );
}

function install(): Promise<number> {
  return run(["consumer", "install", "--product", "keywork", "--installation", "a"]);
}

function compatibleInstall(product = "keywork", installation = "a"): Promise<number> {
  return run([
    "consumer",
    "install",
    "--product",
    product,
    "--installation",
    installation,
    "--contract",
    artifact.contract,
  ]);
}

function useCandidate(version: string): void {
  const bytes = `published engine ${version}`;
  const binary = join(root, `engine-${version}.exe`);
  writeFileSync(binary, bytes);
  artifact = {
    ...artifact,
    version,
    binary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  deps.version = version;
  deps.launch = { program: binary, args: [] };
}

function requiredManager(): ServiceManager {
  if (deps.manager === undefined) throw new Error("Missing test service manager");
  return deps.manager;
}

function attach(id: string, product: string, pid: number): Promise<number> {
  return run([
    "client",
    "attach",
    folder,
    "--product",
    product,
    "--client",
    id,
    "--console",
    String(pid),
  ]);
}

async function inspect() {
  const registry = await RuntimeRegistry.open(nodePaths(root).registry);
  try {
    return {
      runtime: registry.runtime(),
      pending: registry.pendingInstallation(),
      consumers: registry.consumers(),
      clients: registry.clients(now),
    };
  } finally {
    registry.close();
  }
}
