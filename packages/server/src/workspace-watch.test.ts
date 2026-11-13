import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "./events.ts";
import { type WorkspaceChanged, type WorkspaceWatch, watchWorkspace } from "./workspace-watch.ts";

const tempDir = scratchDirs("keywork-workspace-watch-");
const watches: WorkspaceWatch[] = [];

afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
});

function announcementsOn(log: EventLog): WorkspaceChanged[] {
  const heard: WorkspaceChanged[] = [];
  log.subscribe((envelope) => {
    if (envelope.type === "workspace.changed") heard.push(envelope.payload as WorkspaceChanged);
  });
  return heard;
}

async function watched(root: string) {
  const log = new EventLog();
  const heard = announcementsOn(log);
  const watch = watchWorkspace(root, log, { quietMs: 100 });
  watches.push(watch);
  return { heard, watch };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const wholeTreeWatching = process.platform === "win32" || process.platform === "darwin";

describe.runIf(wholeTreeWatching)("watchWorkspace", () => {
  it("announces what changed on disk in one event once the burst settles", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"));
    const { heard } = await watched(root);

    await writeFile(join(root, "src", "math.ts"), "export const one = 1;\n");
    await writeFile(join(root, "notes.md"), "a note\n");
    await until(() => heard.length > 0);

    expect(heard).toHaveLength(1);
    expect(heard[0]?.paths).toEqual(expect.arrayContaining(["notes.md", "src/math.ts"]));
    expect(heard[0]?.truncated).toBe(false);
  });

  it("leaves out .git, node_modules and whatever the ignore files hide", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitignore"), "dist/\n*.log\n");
    await mkdir(join(root, "src"));
    for (const dir of [".git", "node_modules/pkg", "dist"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    const { heard } = await watched(root);

    await writeFile(join(root, ".git", "index"), "staged");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module");
    await writeFile(join(root, "dist", "bundle.js"), "built");
    await writeFile(join(root, "debug.log"), "noise");
    await writeFile(join(root, "src", "kept.ts"), "kept");
    await until(() => heard.some((change) => change.paths.includes("src/kept.ts")));

    const announced = heard.flatMap((change) => change.paths);
    expect(announced).toContain("src/kept.ts");
    expect(announced.filter((path) => /^(\.git|node_modules|dist)\b|\.log$/.test(path))).toEqual(
      [],
    );
  });

  it("stops announcing once closed", async () => {
    const root = await tempDir();
    const { heard, watch } = await watched(root);

    watch.close();
    await writeFile(join(root, "late.md"), "late");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(heard).toEqual([]);
  });
});

describe("watchWorkspace without whole-tree watching", () => {
  it("watches nothing rather than walking every folder", async () => {
    const watch = watchWorkspace(await tempDir(), new EventLog(), { platform: "linux" });
    expect(watch.watching).toBe(false);
  });
});
