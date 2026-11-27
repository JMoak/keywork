import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ShadowRepo {
  gitDir: string;
  notice?: ((text: string) => void) | undefined;
}

export interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class CheckpointsBusyError extends Error {
  constructor(readonly lock: string) {
    super(
      `another keywork engine on this machine holds this workspace's checkpoints (${basename(lock)})`,
    );
    this.name = "CheckpointsBusyError";
  }
}

// Only keywork engines run git in a shadow repository. In one process its commands take turns (one
// queue per repository), and while a turn runs the process keeps a mark, keywork-running/<pid>,
// rewritten every few seconds. So a lock git refuses on belongs to another process, or was left by
// one that stopped partway (on Windows the app stops its engine with a forced kill of the whole
// tree). Such a lock is removed only when it has not changed for two seconds and no other process
// that is still alive has a mark rewritten in the last half minute. An engine running a command,
// however long the command, keeps its mark fresh, so its lock is never removed; it is waited for, at
// most five seconds, and then the command fails as busy.
export function inTurn<T>(repo: ShadowRepo, task: () => Promise<T>): Promise<T> {
  const key = repoKey(repo.gitDir);
  const run = (turns.get(key) ?? Promise.resolve()).then(() => marked(repo.gitDir, task));
  const done = run.then(nothing, nothing);
  turns.set(key, done);
  void done.then(() => {
    if (turns.get(key) === done) turns.delete(key);
  });
  return run;
}

export async function runPastLocks(
  repo: ShadowRepo,
  attempt: () => Promise<GitRun>,
): Promise<GitRun> {
  const deadline = Date.now() + lockWaitMs;
  for (let pause = firstPauseMs; ; pause = Math.min(pause * 2, longestPauseMs)) {
    const run = await attempt();
    const lock = run.code === 0 ? undefined : refusedLock(run.stderr, repo.gitDir);
    if (lock === undefined) return run;
    if (Date.now() >= deadline) throw new CheckpointsBusyError(lock);
    const standing = await standingOf(lock, repo.gitDir);
    if (standing === "left" && (await removedLeftLock(lock, repo.gitDir))) {
      repo.notice?.(
        `checkpoints: removed ${basename(lock)}, left in the shadow repository by an engine that stopped while it worked`,
      );
    } else if (standing !== "gone") {
      await sleep(pause);
    }
  }
}

const lockWaitMs = 5_000;
const firstPauseMs = 25;
const longestPauseMs = 400;
const lockSettledMs = 2_000;
const markRewriteMs = 5_000;
const markFreshMs = 30_000;
const marksDir = "keywork-running";
const lockRefusal = /Unable to create '([^']+\.lock)': File exists/;

const turns = new Map<string, Promise<unknown>>();

type Standing = "gone" | "held" | "left";

async function marked<T>(gitDir: string, task: () => Promise<T>): Promise<T> {
  const mark = join(gitDir, marksDir, String(process.pid));
  let writing = writeMark(mark);
  await writing;
  const rewriting = setInterval(() => {
    writing = writing.then(() => writeMark(mark));
  }, markRewriteMs);
  rewriting.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(rewriting);
    await writing;
    await rm(mark, { force: true }).catch(nothing);
  }
}

async function writeMark(mark: string): Promise<void> {
  await writeFile(mark, "")
    .catch(async () => {
      await mkdir(dirname(mark), { recursive: true });
      await writeFile(mark, "");
    })
    .catch(nothing);
}

function refusedLock(stderr: string, gitDir: string): string | undefined {
  const named = lockRefusal.exec(stderr)?.[1];
  if (named === undefined) return undefined;
  const lock = resolve(named);
  const inside = relative(resolve(gitDir), lock);
  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : lock;
}

async function standingOf(lock: string, gitDir: string): Promise<Standing> {
  const look = await stat(lock).catch(() => undefined);
  if (look === undefined) return "gone";
  if (Date.now() - look.mtimeMs < lockSettledMs) return "held";
  return (await otherMarks(gitDir)).some((mark) => mark.running) ? "held" : "left";
}

async function removedLeftLock(lock: string, gitDir: string): Promise<boolean> {
  const removed = await rm(lock).then(
    () => true,
    () => false,
  );
  if (removed) {
    for (const mark of await otherMarks(gitDir)) {
      if (!mark.running) await rm(mark.path, { force: true }).catch(nothing);
    }
  }
  return removed;
}

interface Mark {
  path: string;
  running: boolean;
}

async function otherMarks(gitDir: string): Promise<Mark[]> {
  const dir = join(gitDir, marksDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const others = names.filter((name) => name !== String(process.pid));
  return Promise.all(
    others.map(async (name) => {
      const path = join(dir, name);
      const look = await stat(path).catch(() => undefined);
      const fresh = look !== undefined && Date.now() - look.mtimeMs < markFreshMs;
      return { path, running: fresh && isAlive(Number(name)) };
    }),
  );
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function repoKey(gitDir: string): string {
  const path = resolve(gitDir);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function nothing(): undefined {
  return undefined;
}
