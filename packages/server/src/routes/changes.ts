import { utf8Prefix } from "@keywork/shared";
import type { ChangesRefusal, FileSides } from "../host.ts";
import { answering } from "./answers.ts";
import { json, missingSession, type RouteFamily, type RouteSpec } from "./family.ts";

export type FileChangeNote = "binary" | "new" | "deleted" | "unreadable";

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  note?: FileChangeNote;
  truncated: boolean;
}

export const fileChangeCapBytes = 1024 * 1024;

const missingResponse = "No session has that id.";
const noBaselineResponse =
  '`{ error: "no baseline" }`: checkpoints are off for this server, so there is no session start to diff against.';

export const changesRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/changes",
    operationId: "readSessionChanges",
    summary:
      "Every file in the workspace that differs from the checkpoint taken when this server first captured it (`baseline` names it: `session start`). Each entry carries the path relative to the workspace root, the lines `added` and `deleted`, and `turn`, the 1-based ordinal of the turn that last touched it, where a turn in this process did. The list is recomputed on every call; `changes.updated` says when to call again.",
    authenticated: true,
    responses: {
      "200": "`{ baseline, files: [{ path, added, deleted, turn? }] }`.",
      "404": missingResponse,
      "409": noBaselineResponse,
    },
  },
  {
    method: "GET",
    path: "/sessions/{id}/changes/file",
    operationId: "readChangedFile",
    summary:
      'Both sides of one changed file, for a client that renders the diff itself: `before` as it was at the baseline and `after` as it is in the working tree, each `null` when the file did not exist on that side (`note` says `new` or `deleted`; `unreadable` when neither side could be read). A file with a NUL byte on either side answers `note: "binary"` with no text. Each side is capped at 1 MiB of UTF-8, cut on a character boundary, and `truncated` says when a side was cut. `path` is the query parameter, relative to the workspace root as GET /sessions/{id}/changes lists it, and is confined to the workspace scope.',
    authenticated: true,
    responses: {
      "200":
        '`{ path, before, after, note?: "binary" | "new" | "deleted" | "unreadable", truncated }`.',
      "400": "No `path` query parameter.",
      "403": "The path escapes the workspace scope.",
      "404": missingResponse,
      "409": noBaselineResponse,
      "413": "The working file is over the 20 MiB cap GET /files applies.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const changesFamily = {
  routes: changesRoutes,
  handlers: ({ host }) => ({
    readSessionChanges: answering(async (_request, { id }) => {
      const report = await host.changes.list(id ?? "");
      return typeof report === "string" ? refused(report) : json(200, report);
    }),
    readChangedFile: answering(async (request, { id }) => {
      const path = new URL(request.url).searchParams.get("path");
      if (path === null || path === "") return json(400, { error: "path is required" });
      const sides = await host.changes.file(id ?? "", path);
      return typeof sides === "string" ? refused(sides) : json(200, fileChangeOf(path, sides));
    }),
  }),
} satisfies RouteFamily<typeof changesRoutes>;

export function fileChangeOf(path: string, { before, after }: FileSides): FileChange {
  if (isBinary(before) || isBinary(after)) {
    return { path, before: null, after: null, note: "binary", truncated: false };
  }
  const note = noteOf(before, after);
  const left = capped(before);
  const right = capped(after);
  return {
    path,
    before: left.text,
    after: right.text,
    ...(note !== undefined && { note }),
    truncated: left.truncated || right.truncated,
  };
}

function refused(outcome: ChangesRefusal): Response {
  return outcome === "missing" ? missingSession() : json(409, { error: "no baseline" });
}

function noteOf(before: string | undefined, after: string | undefined): FileChangeNote | undefined {
  if (before === undefined && after === undefined) return "unreadable";
  if (before === undefined) return "new";
  if (after === undefined) return "deleted";
  return undefined;
}

function isBinary(content: string | undefined): boolean {
  return content?.includes("\0") === true;
}

function capped(content: string | undefined): { text: string | null; truncated: boolean } {
  return content === undefined
    ? { text: null, truncated: false }
    : utf8Prefix(content, fileChangeCapBytes);
}
