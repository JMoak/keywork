import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Checkpoints, type TreeChanges } from "../checkpoints.ts";
import { bashTool, detectShell } from "./bash.ts";
import { changeReport, reportingChanges, type WorktreeChanges } from "./command-changes.ts";
import { maxOutputChars } from "./command-run.ts";

const scratch = scratchDirs("keywork-command-changes-");

async function project(files: Record<string, string>): Promise<{
  worktree: string;
  checkpoints: Checkpoints;
}> {
  const root = await scratch();
  const worktree = join(root, "project");
  await mkdir(worktree);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(worktree, name), content, "utf8");
  }
  const checkpoints = await Checkpoints.open({ worktree, gitDir: join(root, "shadow") });
  return { worktree, checkpoints };
}

function reportingBash(worktree: string, changes: WorktreeChanges) {
  return reportingChanges(bashTool(worktree, detectShell()), changes);
}

describe("reportingChanges", () => {
  it("appends a two-file diff when a command edits two files", async () => {
    const { worktree, checkpoints } = await project({ "a.txt": "alpha\n", "b.txt": "beta\n" });

    const output = await reportingBash(worktree, checkpoints).execute({
      command: "printf 'alpha two\\n' > a.txt && printf 'more\\n' >> b.txt && echo done",
    });

    expect(output).toMatch(
      /^done\n\nchanged 2 files on disk:\n {2}a\.txt \+1 -1\n {2}b\.txt \+1 -0/,
    );
    expect(output).toContain("diff --git a/a.txt b/a.txt");
    expect(output).toContain("+alpha two");
    expect(output).toContain("diff --git a/b.txt b/b.txt");
    expect(output).toContain("+more");
  });

  it("leaves a read-only command's output alone", async () => {
    const { worktree, checkpoints } = await project({ "a.txt": "alpha\n" });

    const output = await reportingBash(worktree, checkpoints).execute({ command: "cat a.txt" });

    expect(output).toBe("alpha");
  });

  it("shows an AGENTS.md rewrite the write guard never sees", async () => {
    const { worktree, checkpoints } = await project({ "AGENTS.md": "# rules\n" });

    const output = await reportingBash(worktree, checkpoints).execute({
      command: "printf '# new rules\\n' > AGENTS.md",
    });

    expect(output).toContain("changed 1 file on disk:\n  AGENTS.md +1 -1");
    expect(output).toContain("+# new rules");
  });

  it("runs the command plainly when there is no worktree to watch", async () => {
    const tool = bashTool(".", detectShell());

    expect(reportingChanges(tool, undefined)).toBe(tool);
  });

  it("still returns the output when a snapshot fails", async () => {
    const { worktree } = await project({});
    const broken: WorktreeChanges = {
      snapshot: () => Promise.reject(new Error("no git")),
      changesBetween: () => Promise.reject(new Error("no git")),
    };

    expect(await reportingBash(worktree, broken).execute({ command: "echo hi" })).toBe("hi");
  });
});

describe("changeReport", () => {
  it("lists paths with line counts instead of a diff over the cap", () => {
    const changes: TreeChanges = {
      files: [
        { path: "big.txt", added: 4000, deleted: 0 },
        { path: "small.txt", added: 1, deleted: 1 },
      ],
      patch: "x".repeat(maxOutputChars + 1),
    };

    const report = changeReport(changes) ?? "";

    expect(report).toContain("  big.txt +4000 -0\n  small.txt +1 -1");
    expect(report).toContain("over the 30000 cap");
    expect(report).not.toContain("xxxx");
  });

  it("has nothing to say when no file changed", () => {
    expect(changeReport({ files: [], patch: "" })).toBeUndefined();
  });
});
