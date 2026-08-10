import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CheckpointsOptions {
  worktree: string;
  gitDir: string;
  limit?: number;
}

const defaultLimit = 64;

const repoStateVars = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
]);

function withoutRepoStateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !repoStateVars.has(key)));
}

export class Checkpoints {
  private readonly undoTrees: string[] = [];
  private readonly redoTrees: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly worktree: string,
    private readonly gitDir: string,
    private readonly limit: number,
  ) {}

  static async open(options: CheckpointsOptions): Promise<Checkpoints> {
    const store = new Checkpoints(options.worktree, options.gitDir, options.limit ?? defaultLimit);
    await store.initShadowRepo();
    return store;
  }

  canUndo(): boolean {
    return this.undoTrees.length > 0;
  }

  canRedo(): boolean {
    return this.redoTrees.length > 0;
  }

  capture(): Promise<void> {
    return this.serialized(async () => {
      const tree = await this.snapshotWorktree();
      this.redoTrees.length = 0;
      if (this.undoTrees.at(-1) === tree) return;
      this.undoTrees.push(tree);
      if (this.undoTrees.length > this.limit) this.undoTrees.shift();
    });
  }

  undo(): Promise<boolean> {
    return this.travel(this.undoTrees, this.redoTrees);
  }

  redo(): Promise<boolean> {
    return this.travel(this.redoTrees, this.undoTrees);
  }

  private travel(from: string[], onto: string[]): Promise<boolean> {
    return this.serialized(async () => {
      const target = from.pop();
      if (target === undefined) return false;
      onto.push(await this.snapshotWorktree());
      await this.git("read-tree", "--reset", "-u", target);
      return true;
    });
  }

  private async snapshotWorktree(): Promise<string> {
    await this.git("add", "-A");
    return this.git("write-tree");
  }

  private async initShadowRepo(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true });
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    await this.git("init", "--quiet");
    await this.git("config", "core.autocrlf", "false");
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private git(...args: string[]): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, {
        cwd: this.worktree,
        windowsHide: true,
        env: {
          ...withoutRepoStateEnv(process.env),
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: this.worktree,
          GIT_INDEX_FILE: join(this.gitDir, "index"),
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else rejectPromise(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }
}
