import {
  contextEntriesFor,
  hunkDigestPattern,
  hunkHeaderPattern,
  hunkVerdicts,
  isReviewVerdict,
  type ReviewVerdict,
  type SessionEntry,
  type VerdictMark,
  verdictMarksOf,
} from "@keywork/engine";
import { utf8Prefix } from "@keywork/shared";
import type { ChangesPort, ChangesRefusal, FileSides, SessionEntries } from "../host.ts";
import { answering } from "./answers.ts";
import {
  bodyOf,
  type JsonSchema,
  json,
  missingSession,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export type FileChangeNote = "binary" | "new" | "deleted" | "unreadable";

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  note?: FileChangeNote;
  truncated: boolean;
}

export const fileChangeCapBytes = 1024 * 1024;

export interface HunkVerdicts {
  verdicts: readonly VerdictMark[];
}

export interface VerdictPort {
  verdict(id: string, verdict: ReviewVerdict): Promise<VerdictMark | "missing">;
}

export const verdictsUnwiredResponse =
  '`{ error: "verdicts are not wired" }`: this server\'s host records no hunk verdicts yet, so the verdict was not written.';

const hunkVerdictBody: JsonSchema = {
  type: "object",
  required: ["path", "header", "digest", "verdict"],
  properties: {
    path: { type: "string", minLength: 1 },
    header: { type: "string", pattern: hunkHeaderPattern.source },
    digest: { type: "string", pattern: hunkDigestPattern.source },
    verdict: { type: "string", enum: [...hunkVerdicts] },
  },
  additionalProperties: false,
};

const missingResponse = "No session has that id.";
const noBaselineResponse =
  '`{ error: "no baseline" }`: checkpoints are off for this server, so there is no session start to diff against.';

export const changesRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/changes",
    operationId: "readSessionChanges",
    summary:
      "Every file this session's turns touched that differs now from the checkpoint taken before the session's first change (`baseline` names it: `session start`). Files only another session or a person outside keywork changed are not listed, so two sessions on one workspace each see their own work. A file both touched shows its net change, theirs included. Each entry carries the path relative to the workspace root, the lines `added` and `deleted`, and `turn`, the 1-based ordinal of the session's turn that last touched it. A settled turn's files are the ones its `turn_facts` journal entry froze when it settled, so the list reads the same after a restart; the turn still running is measured from its own checkpoint. The list is recomputed on every call; `changes.updated` says when to call again.",
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
  {
    method: "GET",
    path: "/sessions/{id}/changes/verdicts",
    operationId: "readHunkVerdicts",
    summary:
      "The keeper's verdicts on the hunks of this session's changes, oldest first: every `keywork.review.verdict` entry on the session's active path, each `{ index, entryId, at, path, header, digest, verdict }`. `path` is the changed file as GET /sessions/{id}/changes lists it, `header` the hunk's unified range line (`@@ -a,b +c,d @@`), `digest` eight hex characters over the hunk's removed and added lines (the stable reference a quote in the thread carries as `hunk <digest>`, which survives the hunk moving when an earlier hunk is dropped), and `verdict` one of `keep`, `drop`, `ask`. The same hunk judged twice appears twice; the last word stands, so a client folds the trail by `path` and `digest`. `index` is the position in `GET /sessions/{id}` `messages` the entry was written before, where `verdicts` lists the same marks for a transcript that replays the trail as notices. Since contract 1.18.",
    authenticated: true,
    responses: {
      "200": "`{ verdicts: [{ index, entryId, at, path, header, digest, verdict }] }`.",
      "404": missingResponse,
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/changes/verdicts",
    operationId: "recordHunkVerdict",
    summary:
      "Record the keeper's verdict on one hunk: `keep`, `drop` or `ask`. The verdict is written to the session as a journal-only `keywork.review.verdict` entry (never a prompt, never in the model context, so no turn starts) and the same write emits one `extension.notice` from the `review` extension, `message` the trail line a transcript draws (`<verdict> · <path> <header> · hunk <digest>`) and `detail: { verdict: <the mark>, entryId }`, so a watching console updates its marks and its conversation at once. A verdict of `ask` parks the hunk as something waiting on the keeper until a later `keep` or `drop` on the same `path` and `digest`. The body names the hunk exactly as GET /sessions/{id}/changes/verdicts lists it. Since contract 1.18.",
    authenticated: true,
    requestBody: hunkVerdictBody,
    responses: {
      "201": "The mark as GET /sessions/{id}/changes/verdicts lists it.",
      "400":
        "The body is not `{ path, header, digest, verdict }` with a unified hunk header, an eight-hex digest and a verdict of keep, drop or ask.",
      "404": missingResponse,
      "501": verdictsUnwiredResponse,
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
    readHunkVerdicts: answering(async (_request, { id }) => {
      const entries = await host.tree.entries(id ?? "");
      return entries === "missing" ? missingSession() : json(200, hunkVerdictsOf(entries));
    }),
    recordHunkVerdict: answering(async (request, { id }) => {
      const verdict = await bodyOf(request);
      if (!isReviewVerdict(verdict)) {
        return json(400, { error: "the body must be { path, header, digest, verdict }" });
      }
      const port = verdictPortOf(host.changes);
      if (port === undefined) return json(501, { error: "verdicts are not wired" });
      const recorded = await port.verdict(id ?? "", verdict);
      return recorded === "missing" ? missingSession() : json(201, recorded);
    }),
  }),
} satisfies RouteFamily<typeof changesRoutes>;

export function hunkVerdictsOf(entries: SessionEntries): HunkVerdicts {
  const onPath = new Set(entries.activePath);
  const path = entries.entries.filter((entry: SessionEntry) => onPath.has(entry.id));
  return { verdicts: verdictMarksOf(contextEntriesFor(path)) };
}

export function verdictPortOf(changes: ChangesPort): VerdictPort | undefined {
  const candidate = changes as Partial<VerdictPort>;
  return typeof candidate.verdict === "function" ? (candidate as VerdictPort) : undefined;
}

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
