import { stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SessionStore } from "@keywork/engine";
import { type ExportScope, sessionHtml } from "./export-html.ts";
import { findSession } from "./store.ts";

export interface ExportRequest {
  scope: ExportScope;
  out?: string | undefined;
  cwd: string;
}

export async function exportSession(store: SessionStore, request: ExportRequest): Promise<string> {
  const target = await exportTarget(store.file, request);
  await writeFile(target, sessionHtml(store, request.scope), "utf8");
  return target;
}

export type LiveStores = (sessionId: string) => SessionStore | undefined;

export function sessionExporter(
  dir: string,
  cwd: string,
  live: LiveStores,
): (sessionId: string, args: string | undefined) => Promise<string> {
  return async (sessionId, args) => {
    const store = live(sessionId) ?? (await findSession(dir, sessionId));
    if (store === undefined) throw new Error(`no session matches id ${sessionId}`);
    return exportSession(store, { ...parseExportArgs(args), cwd });
  };
}

export function parseExportArgs(args: string | undefined): Omit<ExportRequest, "cwd"> {
  const trimmed = (args ?? "").trim();
  const tree = /^tree(?:\s|$)/.test(trimmed);
  const out = (tree ? trimmed.slice("tree".length) : trimmed).trim();
  return { scope: tree ? "tree" : "path", ...(out !== "" && { out }) };
}

async function exportTarget(sessionFile: string, request: ExportRequest): Promise<string> {
  const beside = besideSessionFile(sessionFile, request.scope);
  if (request.out === undefined) return beside;
  const chosen = resolve(request.cwd, request.out);
  return (await isDirectory(chosen)) ? join(chosen, basename(beside)) : chosen;
}

function besideSessionFile(sessionFile: string, scope: ExportScope): string {
  const stem = sessionFile.replace(/\.jsonl$/, "");
  return `${stem}${scope === "tree" ? ".tree" : ""}.html`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
