export type SandboxMode = "off" | "workspace" | "isolated";
export type ConfiningMode = Exclude<SandboxMode, "off">;

export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Sandbox {
  readonly mode: SandboxMode;
  readonly refusal: SandboxRefusal | undefined;
  confine(launch: Launch): Launch;
}

export class SandboxRefusal extends Error {
  constructor(
    readonly mode: ConfiningMode,
    readonly fact: string,
    readonly remedy: string,
  ) {
    super(`sandbox ${mode} refused: ${fact} · ${remedy}`);
    this.name = "SandboxRefusal";
  }
}

export const unconfined: Sandbox = {
  mode: "off",
  refusal: undefined,
  confine: (launch) => launch,
};

export function refusingSandbox(refusal: SandboxRefusal): Sandbox {
  return {
    mode: refusal.mode,
    refusal,
    confine: () => {
      throw refusal;
    },
  };
}

export function sandboxedToolNote(sandbox: Sandbox): string {
  if (sandbox.mode === "off" || sandbox.refusal !== undefined) return "";
  return ` Commands run sandboxed: ${sandboxPromise(sandbox.mode)}.`;
}

export function sandboxPromise(mode: ConfiningMode): string {
  return mode === "workspace"
    ? "writes outside the workspace, temp and package caches fail as a read-only file system"
    : "only the workspace is writable, temp is private, and there's no network";
}
