import type { PermissionsView } from "@keywork/engine";
import type { GrantRevocation, KeyworkClient } from "@keywork/server";
import { grantFromLabel, type PermissionRule, ruleLabel } from "@keywork/shared";
import { type CommandIo, type ResolvedCommandIo, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import {
  type WorkspacePermissionsOptions,
  workspacePermissions,
  workspacePermissionsRecordedAt,
} from "./workspace-permissions.ts";

export type PermissionsRoots = Omit<WorkspacePermissionsOptions, "user">;

export interface PermissionsSeams {
  runningServer?: () => Promise<KeyworkClient | undefined>;
}

export const permissionsUsage =
  "usage: keywork permissions [list] · keywork permissions revoke <action> <resource>";

export async function permissionsCommand(
  args: readonly string[],
  roots: PermissionsRoots,
  io: CommandIo = {},
  seams: PermissionsSeams = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [verb = "list", ...rest] = args;
  switch (verb) {
    case "list":
      if (rest.length > 0) return refuse(`unexpected argument "${rest[0]}"`, printError);
      for (const line of await describePermissions(roots, seams)) print(line);
      return exitCodes.completed;
    case "revoke":
      return revokeGrant(rest.join(" "), roots, seams, { print, printError });
    default:
      return refuse(`unknown verb "${verb}"`, printError);
  }
}

export async function describePermissions(
  roots: PermissionsRoots,
  seams: PermissionsSeams = {},
): Promise<string[]> {
  const server = await seams.runningServer?.();
  const view =
    server === undefined ? workspacePermissions(roots).view() : await server.listPermissions();
  return [
    ...bundleLines(view),
    "",
    ...workspaceLines(view.workspace, workspacePermissionsRecordedAt(roots)),
    "",
    ...sessionLines(server === undefined ? undefined : { url: server.url, grants: view.session }),
  ];
}

async function revokeGrant(
  label: string,
  roots: PermissionsRoots,
  seams: PermissionsSeams,
  { print, printError }: ResolvedCommandIo,
): Promise<number> {
  const rule = grantFromLabel(label);
  if (rule === undefined) return refuse(unprintedGrant, printError);
  const server = await seams.runningServer?.();
  const outcome =
    server === undefined ? localRevocation(roots, rule) : await server.revokeWorkspaceGrant(rule);
  switch (outcome) {
    case "revoked":
      print(`revoked ${ruleLabel(rule)} · it asks again from the next call on`);
      return exitCodes.completed;
    case "missing":
      printError(`keywork permissions: no workspace grant reads "${ruleLabel(rule)}"`);
      return exitCodes.failed;
    case "malformed":
      return refuse(unprintedGrant, printError);
  }
}

const unprintedGrant = "revoke wants the grant as list prints it";

function localRevocation(roots: PermissionsRoots, rule: PermissionRule): GrantRevocation {
  return workspacePermissions(roots).revokeWorkspace(rule) ? "revoked" : "missing";
}

function bundleLines(view: PermissionsView): string[] {
  if (!view.trusted) {
    return ["trusted reads · off until this folder is trusted (keywork trust)"];
  }
  const allowed = view.bundle.filter((rule) => rule.effect === "allow");
  const asked = view.bundle.filter((rule) => rule.effect === "ask");
  return [
    "trusted reads · fixed in keywork, your own rules win over it",
    ...allowed.map((rule) => `  ${ruleLabel(rule)}`),
    "  still asks, since these forms write or run something:",
    ...asked.map((rule) => `  ${ruleLabel(rule)}`),
  ];
}

function workspaceLines(rules: readonly PermissionRule[], recordedAt: Date | undefined): string[] {
  if (rules.length === 0) {
    return ["workspace grants · none yet · answer an ask with workspace scope to add one"];
  }
  const stamp = recordedAt === undefined ? "" : ` · last changed ${localStamp(recordedAt)}`;
  return [`workspace grants${stamp}`, ...rules.map((rule) => `  ${ruleLabel(rule)}`)];
}

function sessionLines(sessions: SessionGrants | undefined): string[] {
  if (sessions === undefined) {
    return ["session grants · live in the running app only · start keywork serve to list them"];
  }
  const entries = Object.entries(sessions.grants).filter(([, rules]) => rules.length > 0);
  if (entries.length === 0) return [`session grants · none on the server at ${sessions.url}`];
  return [
    `session grants · from the server at ${sessions.url}`,
    ...entries.flatMap(([sessionId, rules]) => [
      `  ${sessionId}`,
      ...rules.map((rule) => `    ${ruleLabel(rule)}`),
    ]),
  ];
}

interface SessionGrants {
  url: string;
  grants: Record<string, PermissionRule[]>;
}

function localStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function refuse(problem: string, printError: (line: string) => void): number {
  printError(`keywork permissions: ${problem}\n${permissionsUsage}`);
  return exitCodes.usage;
}
