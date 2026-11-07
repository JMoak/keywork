import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManagedRuntime, RuntimeRegistry } from "@keywork/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { managedHomeFolder, prepareManagedHome } from "../paths.ts";
import { nodeCommand } from "./command.ts";
import { readNodeConfig, writeNodeConfig } from "./config.ts";
import type { NodeCommandDeps } from "./deps.ts";
import { managed, type ServiceManager } from "./manager.ts";
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
    install: async (registration) => {
      operations.push("install");
      program = registration.launch.program;
      installed = true;
      running = true;
      return managed([]);
    },
    uninstall: async () => {
      operations.push("uninstall");
      installed = false;
      running = false;
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
    expect(operations).toEqual(["install"]);
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
    expect(operations).toEqual(["install"]);
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
    expect(operations).toEqual(["install"]);
    expect(errors.at(-1)).toContain("consumer-conflict");
  });

  it("removes one durable consumer while preserving another", async () => {
    await install();
    await run(["consumer", "install", "--product", "stead", "--installation", "b"]);
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect((await inspect()).consumers.map((consumer) => consumer.id)).toEqual(["stead:b"]);
    expect(operations).toEqual(["install"]);
    expect(JSON.parse(out.at(-1) ?? "{}").kind).toBe("retained");
  });

  it("retains authorized work after the final product is uninstalled", async () => {
    await install();
    authorizedWork = true;
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect((await inspect()).consumers).toEqual([]);
    expect(operations).toEqual(["install"]);
    expect(JSON.parse(out.at(-1) ?? "{}").reasons).toEqual(["work"]);
  });

  it("does not treat an absent consumer or historical marker as service ownership", async () => {
    await install();
    expect(
      await run(["consumer", "remove", "--product", "stead", "--installation", "missing"]),
    ).toBe(0);
    expect(operations).toEqual(["install"]);
    expect(JSON.parse(out.at(-1) ?? "{}").kind).toBe("absent");
  });

  it("removes the service only after the final idle consumer is removed", async () => {
    await install();
    expect(await run(["consumer", "remove", "--product", "keywork", "--installation", "a"])).toBe(
      0,
    );
    expect(operations).toEqual(["install", "uninstall"]);
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
    expect(errors.at(-1)).toContain("active-work");
    expect(operations).toEqual(["install"]);

    expect(
      await nodeCommand(["workspace", "remove", home], deps, {
        print: (line) => out.push(line),
        printError: (line) => errors.push(line),
      }),
    ).toBe(0);
    expect(readNodeConfig(configFile).workspaces).toEqual([]);
    expect(await run(registration, true)).toBe(0);
    expect(
      await run(["consumer", "install", "--product", "stead", "--installation", "b"], true),
    ).toBe(0);
    expect(operations).toEqual(["install", "stop", "install"]);
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
      contract: artifact.contract,
    },
  );
}

function install(): Promise<number> {
  return run(["consumer", "install", "--product", "keywork", "--installation", "a"]);
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
      consumers: registry.consumers(),
      clients: registry.clients(now),
    };
  } finally {
    registry.close();
  }
}
