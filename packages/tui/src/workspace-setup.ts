export type WorkspaceReadiness =
  | { kind: "ready"; root: string; vault: string }
  | { kind: "undeclared"; root: string }
  | { kind: "undecided"; root: string }
  | { kind: "refused"; root: string };

export interface WorkspaceSetupReceipt {
  root: string;
  vault: string;
  reopens: boolean;
}

export interface WorkspaceSetupPort {
  readiness(): WorkspaceReadiness;
  setUp(): Promise<WorkspaceSetupReceipt>;
}

export function readinessNotice(readiness: WorkspaceReadiness): string | undefined {
  switch (readiness.kind) {
    case "ready":
      return undefined;
    case "undeclared":
      return `no workspace at ${readiness.root} yet · memory and arcs need one · /init sets it up`;
    case "undecided":
      return `${readiness.root} isn't trusted yet · memory and arcs stay off until it is · /init trusts it and sets up the workspace`;
    case "refused":
      return `${readiness.root} is marked untrusted · memory and arcs stay off · keywork trust reverses that`;
  }
}

export function setupPrompt(readiness: WorkspaceReadiness): string | undefined {
  switch (readiness.kind) {
    case "undecided":
      return `trust ${readiness.root}? keywork keeps workspace files and memory in .keywork`;
    case "undeclared":
      return `set up a workspace at ${readiness.root}? memory lives in .keywork`;
    case "ready":
    case "refused":
      return undefined;
  }
}

export function describeReady(readiness: WorkspaceReadiness): string {
  return readiness.kind === "ready"
    ? `workspace ready at ${readiness.root} · memory lives in ${readiness.vault}`
    : (readinessNotice(readiness) ?? "");
}

export function setupReceiptNotice(receipt: WorkspaceSetupReceipt): string {
  return receipt.reopens
    ? `workspace ready at ${receipt.root} · reopening with memory and arcs live`
    : `workspace ready at ${receipt.root} · reopen keywork to bring memory and arcs up`;
}
