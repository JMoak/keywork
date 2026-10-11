import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Checkpoints, coreTools, EventBus, toolScope } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  checkpointBaseline,
  DiffModel,
  FileChangeFeed,
  followMutations,
  workingFileReader,
} from "./diff-model.ts";

const scratch = scratchDirs("keywork-diff-shell-");

async function shellWorld(files: Record<string, string>) {
  const root = await scratch();
  const worktree = join(root, "project");
  await mkdir(worktree);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(worktree, name), content, "utf8");
  }
  const checkpoints = await Checkpoints.open({ worktree, gitDir: join(root, "shadow") });
  const bus = new EventBus();
  const feed = new FileChangeFeed();
  followMutations(bus, feed);
  const model = new DiffModel(
    {
      baseline: checkpointBaseline(checkpoints),
      readFile: workingFileReader(worktree),
      changes: feed,
    },
    () => {},
    () => {},
  );
  await model.settled();
  const bash = coreTools(toolScope(worktree), { worktree: checkpoints }).find(
    (tool) => tool.name === "bash",
  );
  const run = async (command: string, callId: string): Promise<string> => {
    bus.emit("tool.started", {
      call: { type: "tool-call", callId, name: "bash", arguments: { command } },
    });
    const output = (await bash?.execute({ command })) ?? "";
    bus.emit("tool.finished", { callId, output, isError: false });
    await model.settled();
    return output;
  };
  return { model, run };
}

describe("a shell command in the diff pane", () => {
  it("shows both files a command edits, in the tool result and in the pane", async () => {
    const { model, run } = await shellWorld({ "a.txt": "alpha\n", "b.txt": "beta\n" });

    const output = await run("printf 'alpha two\\n' > a.txt && printf 'more\\n' >> b.txt", "c1");

    expect(output).toContain("changed 2 files on disk:");
    expect(model.changedFiles().map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("shows nothing for a read-only command", async () => {
    const { model, run } = await shellWorld({ "a.txt": "alpha\n" });

    const output = await run("cat a.txt", "c1");

    expect(output).toBe("alpha");
    expect(model.changedFiles()).toEqual([]);
  });
});
