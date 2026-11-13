import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export interface CheckpointsOptions {
  worktree: string;
  gitDir: string;
  limit?: number;
}

export interface ChangedPath {
  path: string;
  added: number;
  deleted: number;
  turn?: number;
}

export interface TreeChanges {
  files: ChangedPath[];
  patch: string;
}

export interface CheckpointReads {
  baseline(): Promise<string>;
  changedSince(tree: string): Promise<ChangedPath[]>;
  contentAt(tree: string, path: string): Promise<string | undefined>;
}

export class UnknownCheckpointError extends Error {
  constructor(readonly tree: string) {
    super(`no checkpoint with tree ${tree}`);
    this.name = "UnknownCheckpointError";
  }
}

type StagedGit = (args: readonly string[], input?: string) => Promise<string>;

interface PathMove {
  path: string;
  mode: string;
  object: string;
}

const defaultLimit = 64;
const treeHashShape = /^[0-9a-f]{40,64}$/;
const neverCheckpointedDirs = ["node_modules", ".git"];
const neverCheckpointedSpecs = neverCheckpointedDirs.map((dir) => `:(glob)**/${dir}/**`);

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

export class Checkpoints implements CheckpointReads {
  private readonly undoTrees: string[] = [];
  private readonly redoTrees: string[] = [];
  private readonly turnStarts: string[] = [];
  private readonly touchedByTurn = new Map<string, number>();
  private turnsAttributed = 0;
  private baselineTree: string | undefined;
  private turnTag: string | undefined;
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

  async capture(): Promise<void> {
    await this.captureTree();
  }

  captureTree(): Promise<string> {
    return this.serialized(async () => {
      const tree = await this.snapshotWorktree();
      this.baselineTree ??= tree;
      if (this.turnTag === undefined) this.turnStarts.push(tree);
      this.turnTag ??= tree;
      this.redoTrees.length = 0;
      if (this.undoTrees.at(-1) !== tree) this.pushBounded(this.undoTrees, tree);
      return tree;
    });
  }

  baseline(): Promise<string> {
    return this.serialized(async () => {
      this.baselineTree ??= await this.snapshotWorktree();
      return this.baselineTree;
    });
  }

  changedSince(tree: string): Promise<ChangedPath[]> {
    return this.serialized(async () => {
      const current = await this.snapshotWorktree();
      const touched = await this.turnsTouching(current);
      return (await this.numstat(tree, current)).map((change) => {
        const turn = touched.get(change.path);
        return turn === undefined ? change : { ...change, turn };
      });
    });
  }

  contentAt(tree: string, path: string): Promise<string | undefined> {
    return this.serialized(() =>
      this.gitRaw("cat-file", "-p", `${tree}:${path}`).catch(() => undefined),
    );
  }

  snapshot(): Promise<string> {
    return this.serialized(() => this.snapshotWorktree());
  }

  filesBetween(from: string, to: string): Promise<ChangedPath[]> {
    return this.serialized(() => (from === to ? Promise.resolve([]) : this.numstat(from, to)));
  }

  changesBetween(from: string, to: string): Promise<TreeChanges> {
    return this.serialized(async () => {
      if (from === to) return { files: [], patch: "" };
      const files = await this.numstat(from, to);
      const patch = await this.gitRaw(
        "diff-tree",
        "-r",
        "-p",
        "--no-color",
        "--no-ext-diff",
        from,
        to,
      );
      return { files, patch: patch.trimEnd() };
    });
  }

  takeTurnTag(): string | undefined {
    const tag = this.turnTag;
    this.turnTag = undefined;
    return tag;
  }

  beginTurn(): void {
    this.turnTag = undefined;
  }

  restoreTo(tree: string, paths?: readonly string[]): Promise<string> {
    return this.serialized(async () => {
      await this.assertKnownTree(tree);
      const source = await this.withoutNeverCheckpointed(tree);
      const current = await this.snapshotWorktree();
      const target = paths === undefined ? source : await this.overlaid(current, source, paths);
      if (current === target) return current;
      this.redoTrees.length = 0;
      this.pushBounded(this.undoTrees, current);
      await this.git("read-tree", "--reset", "-u", target);
      return target;
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

  private async numstat(from: string, to: string): Promise<ChangedPath[]> {
    return parseNumstat(await this.git("diff-tree", "-r", "--numstat", "-z", from, to));
  }

  private async turnsTouching(current: string): Promise<Map<string, number>> {
    for (; this.turnsAttributed + 1 < this.turnStarts.length; this.turnsAttributed += 1) {
      const from = this.turnStarts[this.turnsAttributed] ?? current;
      const to = this.turnStarts[this.turnsAttributed + 1] ?? current;
      await this.attribute(this.touchedByTurn, from, to, this.turnsAttributed + 1);
    }
    const touched = new Map(this.touchedByTurn);
    const openTurn = this.turnStarts.at(-1);
    if (openTurn !== undefined) {
      await this.attribute(touched, openTurn, current, this.turnStarts.length);
    }
    return touched;
  }

  private async attribute(
    into: Map<string, number>,
    from: string,
    to: string,
    turn: number,
  ): Promise<void> {
    if (from === to) return;
    const listing = await this.git("diff-tree", "-r", "--name-only", "-z", from, to);
    for (const path of listing.split("\0")) if (path !== "") into.set(path, turn);
  }

  private async assertKnownTree(tree: string): Promise<void> {
    if (!treeHashShape.test(tree)) throw new UnknownCheckpointError(tree);
    const kind = await this.git("cat-file", "-t", tree).catch(() => "missing");
    if (kind !== "tree") throw new UnknownCheckpointError(tree);
  }

  private pushBounded(trees: string[], tree: string): void {
    trees.push(tree);
    if (trees.length > this.limit) trees.shift();
  }

  private async snapshotWorktree(): Promise<string> {
    await this.git("add", "-A");
    return this.git("write-tree");
  }

  private async withoutNeverCheckpointed(tree: string): Promise<string> {
    const paths = await this.gitRaw("ls-tree", "-r", "-z", "--name-only", tree);
    if (!paths.split("\0").some(isNeverCheckpointed)) return tree;
    return this.rewritten(tree, (staged) =>
      staged([
        "rm",
        "-r",
        "-f",
        "-q",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...neverCheckpointedSpecs,
      ]),
    );
  }

  private async overlaid(base: string, source: string, paths: readonly string[]): Promise<string> {
    const scope = new Set(paths);
    const moves = parseRawDiff(await this.gitRaw("diff-tree", "-r", "-z", base, source));
    const scoped = moves.filter((move) => scope.has(move.path));
    if (scoped.length === 0) return base;
    return this.rewritten(base, (staged) =>
      staged(["update-index", "-z", "--index-info"], indexInfoOf(scoped)),
    );
  }

  private async rewritten(
    tree: string,
    edit: (staged: StagedGit) => Promise<unknown>,
  ): Promise<string> {
    const index = join(this.gitDir, "restore-index");
    const staged: StagedGit = (args, input) =>
      this.gitIn(index, args, input).then((out) => out.trim());
    try {
      await staged(["read-tree", tree]);
      await edit(staged);
      return await staged(["write-tree"]);
    } finally {
      await rm(index, { force: true });
    }
  }

  private async initShadowRepo(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true });
    if (!existsSync(join(this.gitDir, "HEAD"))) {
      await this.git("init", "--quiet");
      await this.git("config", "core.autocrlf", "false");
    }
    await this.writeExcludes();
  }

  private async writeExcludes(): Promise<void> {
    const file = join(this.gitDir, "info", "exclude");
    const wanted = excludePatterns(this.worktree, this.gitDir);
    if ((await readFile(file, "utf8").catch(() => undefined)) === wanted) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, wanted, "utf8");
    await this.git("read-tree", "--empty");
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private git(...args: string[]): Promise<string> {
    return this.gitRaw(...args).then((stdout) => stdout.trim());
  }

  private gitRaw(...args: string[]): Promise<string> {
    return this.gitIn(join(this.gitDir, "index"), args);
  }

  private gitIn(index: string, args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, {
        cwd: this.worktree,
        windowsHide: true,
        env: {
          ...withoutRepoStateEnv(process.env),
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: this.worktree,
          GIT_INDEX_FILE: index,
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
      child.stdin.end(input);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout);
        else rejectPromise(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }
}

function excludePatterns(worktree: string, gitDir: string): string {
  const inside = relative(worktree, gitDir);
  const outside = inside === "" || inside.startsWith("..") || isAbsolute(inside);
  const shadow = outside ? [] : [`/${inside.replaceAll("\\", "/")}/`];
  const dependencies = neverCheckpointedDirs.map((dir) => `${dir}/`);
  return [...shadow, ...dependencies].map((pattern) => `${pattern}\n`).join("");
}

function isNeverCheckpointed(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((dir) => neverCheckpointedDirs.includes(dir));
}

function parseRawDiff(listing: string): PathMove[] {
  const fields = listing.split("\0");
  const moves: PathMove[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, mode = "", , object = ""] = (fields[at] ?? "").split(" ");
    const path = fields[at + 1] ?? "";
    if (path !== "") moves.push({ path, mode, object });
  }
  return moves;
}

function indexInfoOf(moves: readonly PathMove[]): string {
  const removals = moves.filter(isRemoval);
  const writes = moves.filter((move) => !isRemoval(move));
  return [...removals, ...writes]
    .map((move) => `${move.mode} ${move.object}\t${move.path}\0`)
    .join("");
}

function isRemoval(move: PathMove): boolean {
  return Number.parseInt(move.mode, 8) === 0;
}

function parseNumstat(listing: string): ChangedPath[] {
  return listing
    .split("\0")
    .filter((record) => record !== "")
    .flatMap((record) => {
      const [added, deleted, path] = record.split("\t");
      if (path === undefined || path === "") return [];
      return [{ path, added: countOf(added), deleted: countOf(deleted) }];
    });
}

function countOf(field: string | undefined): number {
  const count = Number(field);
  return Number.isInteger(count) ? count : 0;
}
