import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultNodeConfig,
  identityClashOf,
  NodeConfigError,
  nodeConfigDescriptions,
  readNodeConfig,
  withWorkspace,
  writeNodeConfig,
} from "./config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the node config", () => {
  it("defaults to the mesh ports MESH.md adopted and no workspaces", () => {
    expect(readNodeConfig(join(dir, "absent.json"))).toEqual({
      workspaces: [],
      mesh: { enabled: true, port: 47800, screenUdp: { first: 47810, last: 47829 } },
      headless: false,
    });
  });

  it("round-trips through the file and fills what the file leaves out", () => {
    const file = join(dir, "node", "config.json");
    writeNodeConfig(file, {
      ...defaultNodeConfig(),
      workspaces: [{ cwd: "/src/stead", slug: null }],
    });
    expect(readNodeConfig(file).workspaces).toEqual([{ cwd: "/src/stead", slug: null }]);
    writeFileSync(file, JSON.stringify({ mesh: { port: 48000 } }));
    expect(readNodeConfig(file)).toMatchObject({
      mesh: { enabled: true, port: 48000 },
      headless: false,
    });
  });

  it("refuses a config it cannot trust, naming the field", () => {
    const file = join(dir, "config.json");
    const cases: [unknown, string][] = [
      [{ mesh: { port: 70000 } }, "mesh.port"],
      [{ mesh: { screenUdp: { first: 47829, last: 47810 } } }, "runs backwards"],
      [{ workspaces: [{ slug: "x" }] }, "without a cwd"],
      [{ headless: "yes" }, "headless"],
      [[], "not an object"],
    ];
    for (const [data, detail] of cases) {
      writeFileSync(file, JSON.stringify(data));
      expect(() => readNodeConfig(file)).toThrow(NodeConfigError);
      expect(() => readNodeConfig(file)).toThrow(detail);
    }
    writeFileSync(file, "{ not json");
    expect(() => readNodeConfig(file)).toThrow("not valid JSON");
  });

  it("adds a workspace once, however its path is spelled", () => {
    const once = withWorkspace(defaultNodeConfig(), { cwd: join(dir, "stead"), slug: null });
    const twice = withWorkspace(once, { cwd: `${dir}/stead/../stead/`, slug: null });
    const other = withWorkspace(twice, { cwd: join(dir, "stead"), slug: "research" });
    expect(twice.workspaces).toHaveLength(1);
    expect(other.workspaces).toHaveLength(2);
  });

  it("justifies every option it reads", () => {
    expect(Object.keys(nodeConfigDescriptions).sort()).toEqual([
      "headless",
      "mesh.enabled",
      "mesh.port",
      "mesh.screenUdp",
      "workspaces",
      "workspaces.home",
    ]);
  });
});

describe("two folders of one workspace identity", () => {
  function twoFoldersInOneRepo(): { root: string; first: string; second: string } {
    const root = join(dir, "repo");
    const first = join(root, "first");
    const second = join(root, "second");
    for (const folder of [join(root, ".git"), first, second])
      mkdirSync(folder, { recursive: true });
    return { root, first, second };
  }

  it("refuses a node config that lists both, with a sentence naming the anchor", () => {
    const { root, first, second } = twoFoldersInOneRepo();
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ workspaces: [{ cwd: first }, { cwd: second }] }));
    expect(() => readNodeConfig(file)).toThrow(NodeConfigError);
    expect(() => readNodeConfig(file)).toThrow(
      `${first} and ${second} both open the workspace at ${root} (its git root)`,
    );
    expect(() => readNodeConfig(file)).toThrow("would serve it twice on one ticket");
  });

  it("refuses to add the second one, and lets folders outside a repo stand alone", () => {
    const { first, second } = twoFoldersInOneRepo();
    const one = withWorkspace(defaultNodeConfig(), { cwd: first, slug: null });
    expect(() => withWorkspace(one, { cwd: second, slug: null })).toThrow(
      `${second} cannot join the node: ${first} and ${second} both open the workspace at`,
    );
    const loose = [join(dir, "a"), join(dir, "b")];
    for (const folder of loose) mkdirSync(folder, { recursive: true });
    expect(identityClashOf(loose.map((cwd) => ({ cwd, slug: null })))).toBeUndefined();
  });

  it("keeps named workspaces of one repo apart", () => {
    const { first, second } = twoFoldersInOneRepo();
    expect(
      identityClashOf([
        { cwd: first, slug: "alpha" },
        { cwd: second, slug: "beta" },
      ]),
    ).toBeUndefined();
  });
});
