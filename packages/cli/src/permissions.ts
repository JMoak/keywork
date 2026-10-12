import type { PermissionsView } from "@keywork/engine";
import type { ServerTicket } from "@keywork/server";
import { grantFromLabel, type PermissionRule, ruleLabel } from "@keywork/shared";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import {
  type WorkspacePermissionsOptions,
  workspacePermissions,
  workspacePermissionsRecordedAt,
} from "./workspace-permissions.ts";

export type PermissionsRoots = Omit<WorkspacePermissionsOptions, "user">;

export interface PermissionsSeams {
  runningServer?: () => Promise<ServerTicket | undefined>;
  fetch?: typeof fetch;
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
      return revokeGrant(rest.join(" "), roots, print, printError);
    default:
      return refuse(`unknown verb "${verb}"`, printError);
  }
}

export async function describePermissions(
  roots: PermissionsRoots,
  seams: PermissionsSeams = {},
): Promise<string[]> {
  const view = workspacePermissions(roots).view();
  const sessions = await sessionGrantsFromServer(seams);
  return [
    ...bundleLines(view),
    "",
    ...workspaceLines(view.workspace, workspacePermissionsRecordedAt(roots)),
    "",
    ...sessionLines(sessions),
  ];
}

function revokeGrant(
  label: string,
  roots: PermissionsRoots,
  print: (line: string) => void,
  printError: (line: string) => void,
): number {
  const rule = grantFromLabel(label);
  if (rule === undefined) return refuse("revoke wants the grant as list prints it", printError);
  if (!workspacePermissions(roots).revokeWorkspace(rule)) {
    printError(`keywork permissions: no workspace grant reads "${ruleLabel(rule)}"`);
    return exitCodes.failed;
  }
  print(`revoked ${ruleLabel(rule)} · it asks again from the next call on`);
  return exitCodes.completed;
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

async function sessionGrantsFromServer(
  seams: PermissionsSeams,
): Promise<SessionGrants | undefined> {
  const ticket = await seams.runningServer?.();
  if (ticket === undefined) return undefined;
  const call = seams.fetch ?? fetch;
  const url = ticket.url.replace(/\/+$/, "");
  const response = await call(`${url}/permissions`, {
    headers: { authorization: `Bearer ${ticket.token}` },
  });
  if (!response.ok) return undefined;
  const view = (await response.json()) as PermissionsView;
  return { url, grants: view.session };
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
