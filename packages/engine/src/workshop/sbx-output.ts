import type { WorkshopHealth } from "./substrate.ts";

export interface PolicyRule {
  readonly scope: "global" | string;
  readonly kind: string;
  readonly decision: "allow" | "deny";
  readonly resources: readonly string[];
}

export class UnreadableSbxOutput extends Error {
  constructor(command: string, output: string) {
    super(
      `sbx ${command} printed output this adapter does not understand; qualify the parser against the pinned sbx: ${firstLine(output)}`,
    );
    this.name = "UnreadableSbxOutput";
  }
}

export function versionOf(output: string): string {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (found === null) throw new UnreadableSbxOutput("version", output);
  return found.slice(1, 4).join(".");
}

export function diskIn(output: string): { usedBytes: number; sizeBytes: number } {
  const cells = output.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
  const [sizeKb, usedKb] = [cells[1], cells[2]].map(Number);
  if (cells.length < 6 || !Number.isFinite(sizeKb) || !Number.isFinite(usedKb)) {
    throw new UnreadableSbxOutput("exec df -Pk", output);
  }
  return { usedBytes: (usedKb ?? 0) * 1024, sizeBytes: (sizeKb ?? 0) * 1024 };
}

export function memoryIn(meminfo: string): { usedBytes: number; totalBytes: number } {
  const total = meminfoKb(meminfo, "MemTotal");
  const available = meminfoKb(meminfo, "MemAvailable");
  if (total === undefined || available === undefined) {
    throw new UnreadableSbxOutput("exec cat /proc/meminfo", meminfo);
  }
  return { usedBytes: (total - available) * 1024, totalBytes: total * 1024 };
}

export function compareVersions(left: string, right: string): number {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a?.[index] ?? 0) - (b?.[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function healthIn(listing: string, sandbox: string): WorkshopHealth {
  const row = listing.split(/\r?\n/).find((line) => line.trim().split(/\s+/, 1)[0] === sandbox);
  if (row === undefined) return "down";
  const status =
    /running \(not responding\)|running|starting|creating|stopping|stopped|exited/.exec(
      row.slice(sandbox.length),
    )?.[0];
  return healthOfStatus(status);
}

export function policyRulesIn(listing: string): PolicyRule[] {
  const lines = listing.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0 || /^no (rules|policies)/i.test(lines[0]?.trim() ?? "")) return [];
  const header = columnsOf(lines[0] ?? "");
  const decision = header.findIndex((name) => /^(decision|action|effect)$/i.test(name));
  const resources = header.findIndex((name) => /^resources?$/i.test(name));
  if (decision === -1 || resources === -1) throw new UnreadableSbxOutput("policy ls", listing);
  const scope = header.findIndex((name) => /^(scope|sandbox)$/i.test(name));
  const kind = header.findIndex((name) => /^type$/i.test(name));
  return lines.slice(1).map((line) => {
    const cells = columnsOf(line);
    return {
      scope: scopeOf(scope === -1 ? undefined : cells[scope]),
      kind: (kind === -1 ? undefined : cells[kind]) ?? "network",
      decision: decisionOf(cells[decision], listing),
      resources: (cells[resources] ?? "").split(",").map((resource) => resource.trim()),
    };
  });
}

export function allowedFor(rules: readonly PolicyRule[], sandbox: string): string[] {
  return rules
    .filter((rule) => rule.kind === "network" && rule.decision === "allow")
    .filter((rule) => rule.scope === "global" || rule.scope === sandbox)
    .flatMap((rule) => rule.resources)
    .filter((resource) => resource !== "");
}

function healthOfStatus(status: string | undefined): WorkshopHealth {
  switch (status) {
    case "running":
      return "up";
    case "running (not responding)":
      return "unresponsive";
    case "starting":
    case "creating":
      return "starting";
    default:
      return "down";
  }
}

function columnsOf(line: string): string[] {
  return line
    .trim()
    .split(/\s{2,}/)
    .map((cell) => cell.trim());
}

function scopeOf(cell: string | undefined): string {
  if (cell === undefined || /^\(?global\)?$|^-$|^\*$/i.test(cell)) return "global";
  return cell;
}

function decisionOf(cell: string | undefined, listing: string): "allow" | "deny" {
  const decision = cell?.toLowerCase();
  if (decision === "allow" || decision === "deny") return decision;
  throw new UnreadableSbxOutput("policy ls", listing);
}

function meminfoKb(meminfo: string, field: string): number | undefined {
  const found = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(meminfo);
  return found === null ? undefined : Number(found[1]);
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0] ?? "";
}
