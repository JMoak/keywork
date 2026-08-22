import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type Provider, textTurn } from "@keywork/engine";
import { TrustStore, writeNamedWorkspaceDeclaration } from "@keywork/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { usage } from "./dispatch.ts";
import { composeInference } from "./inference/runtime.ts";
import { type MainSeams, main, runUntilSwitch } from "./main.ts";
import { defaultSessionDir } from "./paths.ts";

const tempDirs: string[] = [];
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home = "";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-main-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "keywork-main-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterAll(async () => {
  process.env.HOME = savedHome.HOME;
  process.env.USERPROFILE = savedHome.USERPROFILE;
  await rm(home, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Invocation {
  code: number;
  out: string[];
  err: string[];
}

async function invoke(argv: string[], seams: MainSeams = {}): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd: seams.cwd ?? (await tempDir()),
    env: {},
    interactive: false,
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    ...seams,
  });
  return { code, out, err };
}

const stackFrame = /^\s+at /m;

describe("main(argv) usage contract", () => {
  const table: [argv: string[], code: number, stream: "out" | "err", needle: string][] = [
    [["run", "x", "--nope"], 2, "err", "keywork run: Unknown option '--nope'"],
    [["sessions", "--bogus-flag"], 2, "err", "keywork: Unknown option '--bogus-flag'"],
    [["--help"], 0, "out", "Usage:"],
    [["-h"], 0, "out", "Usage:"],
    [["help"], 0, "out", "Usage:"],
    [["frobnicate"], 2, "err", 'unknown command "frobnicate"'],
    [[], 2, "err", "no command given and no terminal attached"],
    [["run"], 2, "err", "keywork run needs a prompt"],
    [["run", "hi"], 3, "err", "keywork connect"],
    [["sessions", "bogus"], 2, "err", 'keywork sessions: unknown subcommand "bogus"'],
  ];

  it.each(table)("%j exits %i", async (argv, code, stream, needle) => {
    const result = await invoke(argv);
    expect(result.code).toBe(code);
    expect(result[stream].join("\n")).toContain(needle);
    expect(result.err.join("\n")).not.toMatch(stackFrame);
  });

  it("prints the usage block itself for --help and nothing on stderr", async () => {
    const { out, err } = await invoke(["--help"]);
    expect(out).toEqual([usage]);
    expect(err).toEqual([]);
  });

  it("keeps run's JSON contract for a bad flag: one run.finished usage line, exit 2", async () => {
    const { code, out, err } = await invoke(["run", "--json", "x", "--nope"]);
    expect(code).toBe(2);
    expect(err).toEqual([]);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      {
        type: "run.finished",
        outcome: "usage",
        exitCode: 2,
        error: expect.stringContaining("keywork run: Unknown option '--nope'"),
      },
    ]);
  });
});

describe("main(argv) threads global flags to the subcommands", () => {
  it("sessions list --json prints JSON", async () => {
    const { code, out } = await invoke(["sessions", "list", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([]);
  });

  it("run --workspace <slug> reads that workspace's vault and writes its session dir", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "main" }));
    writeNamedWorkspaceDeclaration(cwd, "foo", { name: "Foo" });
    const fooVault = join(cwd, ".keywork", "workspaces", "foo", "memory");
    await writeFile(join(fooVault, "MEMORY.md"), "- [[Foo Rule]]\n");
    await writeFile(
      join(fooVault, "Foo Rule.md"),
      "---\nprovenance: user\npinned: true\n---\nFoo sessions answer in haiku.\n",
    );
    new TrustStore().trust(cwd);
    const systemPrompts: string[] = [];

    const { code, out } = await invoke(["run", "hi", "--workspace", "foo", "--debug"], {
      cwd,
      env: { KEYWORK_OPENAI_API_KEY: "test-key" },
      composeInference: (inputs) => ({
        ...composeInference(inputs),
        provider: () => recordingProvider(systemPrompts),
      }),
    });

    expect(code).toBe(0);
    expect(out).toEqual(["ok"]);
    expect(systemPrompts[0]).toContain("Foo sessions answer in haiku.");
    expect(await readdir(join(defaultSessionDir(cwd, "foo"), "debug"))).toHaveLength(1);
    await expect(readdir(defaultSessionDir(cwd))).rejects.toThrow();
  });
});

describe("runUntilSwitch", () => {
  it("resolves with the workspace the app switched to", async () => {
    await expect(runUntilSwitch(async (switchTo) => switchTo("foo"))).resolves.toBe("foo");
  });

  it("rejects when opening panes fails instead of hanging", async () => {
    await expect(
      runUntilSwitch(async () => {
        throw new Error("extensions dir unreadable");
      }),
    ).rejects.toThrow("extensions dir unreadable");
  });
});

function recordingProvider(systemPrompts: string[]): Provider {
  const inner = new MockProvider([textTurn("ok")]);
  return {
    name: inner.name,
    stream: (request) => {
      systemPrompts.push(request.systemPrompt);
      return inner.stream(request);
    },
  };
}
