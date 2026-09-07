import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type Provider, textTurn } from "@keywork/engine";
import { TrustStore, writeNamedWorkspaceDeclaration } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usage } from "./dispatch.ts";
import { composeInference } from "./inference/runtime.ts";
import { type MainSeams, main, runUntilSwitch } from "./main.ts";
import { defaultSessionDir } from "./paths.ts";

const tempDir = scratchDirs("keywork-main-");
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home = "";

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
    [["serve", "--help"], 2, "err", "keywork: Unknown option '--help'"],
    [["serve", "--port", "http"], 2, "err", "keywork serve: --port wants a whole number"],
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

describe("main(argv) dispatches one call per command", () => {
  const table: [argv: string[], code: number, stream: "out" | "err", needle: string][] = [
    [["trust"], 0, "out", "is now trusted"],
    [["untrust"], 0, "out", "is now untrusted"],
    [["workspace", "list"], 0, "out", "* opens next"],
    [["workspace", "bogus"], 2, "err", 'keywork workspace: unknown subcommand "bogus"'],
    [["link"], 1, "err", "usage: keywork link <dir>"],
    [["doctor"], 0, "out", "keywork doctor"],
    [["sessions"], 0, "out", "no sessions yet"],
    [["panes"], 2, "err", "panes needs a terminal"],
    [["chat"], 2, "err", "chat needs a terminal"],
  ];

  it.each(table)("%j exits %i", async (argv, code, stream, needle) => {
    const result = await invoke(argv);
    expect(result.code).toBe(code);
    expect(result[stream].join("\n")).toContain(needle);
  });

  it("init reports a workspace that is already declared", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "here" }));
    const { code, out } = await invoke(["init"], { cwd });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("already set up");
  });

  it("chat in a terminal refuses without a provider and points at connect", async () => {
    const { code, err } = await invoke(["chat"], { interactive: true });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("keywork connect");
  });
});

describe("main(argv) composes inference only for the commands that need it", () => {
  async function withPoisonedUserConfig<T>(body: () => Promise<T>): Promise<T> {
    const configFile = join(home, ".keywork", "keywork.json");
    await mkdir(join(home, ".keywork"), { recursive: true });
    await writeFile(configFile, JSON.stringify({ permissions: { tools: { bash: "maybe" } } }));
    try {
      return await body();
    } finally {
      await rm(configFile, { force: true });
    }
  }

  it("help, version, sessions, workspace, trust and doctor never load config or inference", async () => {
    let composed = 0;
    const seams: MainSeams = {
      composeInference: (inputs) => {
        composed += 1;
        return composeInference(inputs);
      },
    };
    await withPoisonedUserConfig(async () => {
      for (const argv of [
        ["--help"],
        ["--version"],
        ["sessions", "list"],
        ["workspace"],
        ["trust"],
      ]) {
        expect((await invoke(argv, seams)).code).toBe(0);
      }
      expect((await invoke(["doctor"], seams)).code).toBe(0);
      expect(composed).toBe(0);
      await expect(invoke(["run", "hi"], seams)).rejects.toThrow(/permissions/);
    });
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

describe("--workspace on run and chat", () => {
  it("run refuses an unknown slug as a typed usage failure, exit 2, on the JSON stream too", async () => {
    const cwd = await tempDir();
    const plain = await invoke(["run", "hi", "--workspace", "ghost"], { cwd });
    expect(plain.code).toBe(2);
    expect(plain.err.join("\n")).toContain('keywork run: no workspace named "ghost" here');
    expect(plain.err.join("\n")).not.toContain("opening the default");

    const json = await invoke(["run", "hi", "--workspace", "ghost", "--json"], { cwd });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({
      type: "run.finished",
      outcome: "usage",
      exitCode: 2,
      error: expect.stringContaining('no workspace named "ghost"'),
    });
  });

  it("chat refuses an unknown slug with the usage block, exit 2, before touching inference", async () => {
    const cwd = await tempDir();
    const { code, err } = await invoke(["chat", "--workspace", "ghost"], {
      cwd,
      interactive: true,
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain('keywork: no workspace named "ghost" here');
    expect(err.join("\n")).toContain("Usage:");
  });

  it("run accepts the word default as the default slot and a declared slug as itself", async () => {
    const cwd = await tempDir();
    writeNamedWorkspaceDeclaration(cwd, "foo", { name: "Foo" });
    const chosen = await invoke(["run", "hi", "--workspace", "default"], { cwd });
    expect(chosen.code).toBe(3);
    const named = await invoke(["run", "hi", "--workspace", "foo"], { cwd });
    expect(named.code).toBe(3);
    expect([...chosen.err, ...named.err].join("\n")).not.toContain("no workspace named");
  });
});
