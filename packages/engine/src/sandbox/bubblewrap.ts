import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolScope } from "../tools/confine.ts";
import type { ConfiningMode, Launch, Sandbox } from "./sandbox.ts";

export interface HomeLayout {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface BubblewrapHost extends HomeLayout {
  readonly bubblewrap: string;
}

export interface ConfinementPlan {
  readonly writable: readonly string[];
  readonly hidden: readonly string[];
  readonly network: boolean;
}

export function bubblewrapSandbox(
  mode: ConfiningMode,
  scope: ToolScope,
  host: BubblewrapHost,
): Sandbox {
  return {
    mode,
    refusal: undefined,
    confine: (launch) => confinedLaunch(confinementPlan(mode, scope, host), launch, host),
  };
}

export function confinementPlan(
  mode: ConfiningMode,
  scope: ToolScope,
  layout: HomeLayout,
): ConfinementPlan {
  const workspace = [...scope.roots, ...scope.roots.flatMap(gitDirsOf)];
  const keyworkState = join(layout.home, ".keywork");
  if (mode === "isolated") {
    return {
      writable: existing(workspace),
      hidden: existing(["/tmp", "/run", cacheHome(layout), keyworkState]),
      network: false,
    };
  }
  return {
    writable: existing([...temporaryDirs(layout.env), ...packageCaches(layout), ...workspace]),
    hidden: existing([keyworkState]),
    network: true,
  };
}

export function bubblewrapArgs(plan: ConfinementPlan, launch: Launch): string[] {
  return [
    ...["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
    ...mountsShallowestFirst(plan).flatMap(mountArgs),
    ...["--unshare-pid", "--unshare-ipc"],
    ...(plan.network ? [] : ["--unshare-net"]),
    "--die-with-parent",
    ...["--chdir", launch.cwd],
    "--",
    launch.file,
    ...launch.args,
  ];
}

function confinedLaunch(plan: ConfinementPlan, launch: Launch, host: BubblewrapHost): Launch {
  return {
    file: host.bubblewrap,
    args: bubblewrapArgs(plan, launch),
    cwd: launch.cwd,
    env: plan.network ? launch.env : { ...launch.env, TMPDIR: "/tmp" },
  };
}

type Mount = { kind: "writable" | "hidden"; path: string };

function mountsShallowestFirst(plan: ConfinementPlan): Mount[] {
  const mounts: Mount[] = [
    ...plan.hidden.map((path) => ({ kind: "hidden" as const, path })),
    ...plan.writable.map((path) => ({ kind: "writable" as const, path })),
  ];
  return mounts.sort((left, right) => depthOf(left.path) - depthOf(right.path));
}

function mountArgs(mount: Mount): string[] {
  return mount.kind === "hidden" ? ["--tmpfs", mount.path] : ["--bind", mount.path, mount.path];
}

function depthOf(path: string): number {
  return path.split(/[\\/]/).filter((part) => part !== "").length;
}

function temporaryDirs(env: NodeJS.ProcessEnv): string[] {
  return ["/tmp", "/var/tmp", ...(env.TMPDIR === undefined ? [] : [env.TMPDIR])];
}

function packageCaches(layout: HomeLayout): string[] {
  const home = layout.home;
  return [
    cacheHome(layout),
    join(home, ".npm"),
    join(home, ".bun", "install", "cache"),
    join(home, ".cargo", "registry"),
    join(home, ".cargo", "git"),
    join(home, "go", "pkg", "mod"),
    join(home, ".gradle", "caches"),
    join(home, ".m2", "repository"),
    join(home, ".local", "share", "pnpm", "store"),
    join(home, ".yarn", "berry", "cache"),
    join(home, ".nuget", "packages"),
  ];
}

function cacheHome(layout: HomeLayout): string {
  return layout.env.XDG_CACHE_HOME ?? join(layout.home, ".cache");
}

function gitDirsOf(root: string): string[] {
  const pointer = gitDirPointer(join(root, ".git"));
  if (pointer === undefined) return [];
  const gitDir = resolve(root, pointer);
  const common = firstLine(join(gitDir, "commondir"));
  return [common === undefined ? gitDir : resolve(gitDir, common)];
}

function gitDirPointer(dotGit: string): string | undefined {
  const line = firstLine(dotGit);
  return line?.startsWith("gitdir:") ? line.slice("gitdir:".length).trim() : undefined;
}

function firstLine(file: string): string | undefined {
  if (!isFile(file)) return undefined;
  return readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim() || undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function existing(paths: readonly string[]): string[] {
  const real = paths.filter((path) => existsSync(path)).map((path) => realpathSync.native(path));
  return [...new Set(real)];
}
