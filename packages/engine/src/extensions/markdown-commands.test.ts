import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandRuntime,
  fileEmbedder,
  loadCommands,
  renderCommand,
  scanTemplate,
} from "./markdown-commands.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-commands-"));
  cleanups.push(root);
  return root;
}

async function seed(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

const inertRuntime: CommandRuntime = {
  runShell: () => Promise.reject(new Error("shell must not run")),
  embedFile: () => Promise.resolve(undefined),
};

describe("loadCommands", () => {
  it("loads name, frontmatter, and template from a command file", async () => {
    const root = await scratch();
    await seed(join(root, "commands"), {
      "review.md":
        "---\ndescription: Review the diff\nagent: reviewer\nmodel: some-model\n---\nReview $ARGUMENTS carefully.\n",
    });
    const { commands, failures } = await loadCommands({ projectDir: join(root, "commands") });
    expect(failures).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "review",
      description: "Review the diff",
      agent: "reviewer",
      model: "some-model",
      template: "Review $ARGUMENTS carefully.",
      source: "project",
    });
  });

  it("prefers project commands over user commands with the same name", async () => {
    const root = await scratch();
    await seed(join(root, "project"), { "deploy.md": "project body" });
    await seed(join(root, "user"), {
      "deploy.md": "user body",
      "only-user.md": "user only",
    });
    const { commands } = await loadCommands({
      projectDir: join(root, "project"),
      userDir: join(root, "user"),
    });
    const byName = new Map(commands.map((command) => [command.name, command]));
    expect(byName.get("deploy")?.template).toBe("project body");
    expect(byName.get("deploy")?.source).toBe("project");
    expect(byName.get("only-user")?.template).toBe("user only");
  });

  it("quarantines malformed frontmatter and bad names without failing the load", async () => {
    const root = await scratch();
    await seed(join(root, "commands"), {
      "broken.md": "---\ndescription: never closed\n",
      "bad name!.md": "body",
      "fine.md": "still loads",
    });
    const { commands, failures } = await loadCommands({ projectDir: join(root, "commands") });
    expect(commands.map((command) => command.name)).toEqual(["fine"]);
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.reason).join(" ")).toContain("frontmatter");
  });

  it("returns nothing when no command directories exist", async () => {
    const root = await scratch();
    const { commands, failures } = await loadCommands({
      projectDir: join(root, "missing"),
      userDir: join(root, "also-missing"),
    });
    expect(commands).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe("renderCommand", () => {
  it("substitutes $ARGUMENTS everywhere it appears", async () => {
    const rendered = await renderCommand(
      "fix $ARGUMENTS then test $ARGUMENTS",
      "the bug",
      inertRuntime,
    );
    expect(rendered).toBe("fix the bug then test the bug");
  });

  it("appends arguments when the template has no placeholder", async () => {
    const rendered = await renderCommand("just do it", "with care", inertRuntime);
    expect(rendered).toBe("just do it\n\nwith care");
  });

  it("never re-interpolates tokens smuggled in through arguments", async () => {
    const hostile = "!`rm -rf /` and @../../etc/passwd and $ARGUMENTS";
    const rendered = await renderCommand("run $ARGUMENTS now", hostile, inertRuntime);
    expect(rendered).toBe(`run ${hostile} now`);
  });

  it("runs shell interpolations through the provided runtime only", async () => {
    const ran: string[] = [];
    const rendered = await renderCommand("status: !`git status` done", "", {
      ...inertRuntime,
      runShell: (command) => {
        ran.push(command);
        return Promise.resolve("clean");
      },
    });
    expect(ran).toEqual(["git status"]);
    expect(rendered).toBe("status: clean done");
  });

  it("propagates a declined shell interpolation as a failure", async () => {
    await expect(
      renderCommand("!`whoami`", "", {
        ...inertRuntime,
        runShell: () => Promise.reject(new Error("declined")),
      }),
    ).rejects.toThrow("declined");
  });

  it("embeds file mentions and leaves unresolved mentions literal", async () => {
    const rendered = await renderCommand("see @notes.md and @missing.md", "", {
      ...inertRuntime,
      embedFile: (path) => Promise.resolve(path === "notes.md" ? "note body" : undefined),
    });
    expect(rendered).toBe("see note body and @missing.md");
  });

  it("leaves email-like text alone", async () => {
    const rendered = await renderCommand("mail jordan@example.com", "", inertRuntime);
    expect(rendered).toBe("mail jordan@example.com");
  });

  it("treats an unterminated shell token as literal text", async () => {
    const rendered = await renderCommand("just a bang!` here", "", inertRuntime);
    expect(rendered).toBe("just a bang!` here");
  });
});

describe("scanTemplate", () => {
  it("splits a template into typed segments", () => {
    expect(scanTemplate("a $ARGUMENTS b !`ls` c @x.md")).toEqual([
      { kind: "literal", text: "a " },
      { kind: "arguments" },
      { kind: "literal", text: " b " },
      { kind: "shell", command: "ls" },
      { kind: "literal", text: " c " },
      { kind: "file", path: "x.md", raw: "@x.md" },
    ]);
  });

  it("trims trailing punctuation off file mentions", () => {
    expect(scanTemplate("see @src/main.ts.")).toEqual([
      { kind: "literal", text: "see " },
      { kind: "file", path: "src/main.ts", raw: "@src/main.ts" },
      { kind: "literal", text: "." },
    ]);
  });
});

describe("fileEmbedder", () => {
  it("reads files inside the root and reports missing ones as undefined", async () => {
    const root = await scratch();
    await seed(root, { "notes.md": "hello" });
    const embed = fileEmbedder(root);
    expect(await embed("notes.md")).toBe("hello");
    expect(await embed("absent.md")).toBeUndefined();
  });

  it("refuses paths that escape the root", async () => {
    const root = await scratch();
    const embed = fileEmbedder(join(root, "inner"));
    await expect(embed("../secret.txt")).rejects.toThrow("escapes the project root");
    await expect(embed("../../../../etc/passwd")).rejects.toThrow("escapes the project root");
  });
});
