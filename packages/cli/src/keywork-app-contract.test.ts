import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@keywork/engine";
import type { OpenApiDocument } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "./serve.ts";

const contractMajorTheAppBuildsAgainst = 1;

const routesTheAppCalls = [
  ["GET", "/doc", "getDocument"],
  ["GET", "/events", "streamEvents"],
  ["GET", "/sessions", "listSessions"],
  ["POST", "/sessions", "createSession"],
  ["GET", "/sessions/{id}", "readSession"],
  ["DELETE", "/sessions/{id}", "removeSession"],
  ["POST", "/sessions/{id}/prompt", "promptSession"],
  ["POST", "/sessions/{id}/inject", "injectPrompt"],
  ["POST", "/sessions/{id}/abort", "abortSession"],
  ["GET", "/sessions/{id}/entries", "readSessionEntries"],
  ["POST", "/sessions/{id}/fork", "forkSession"],
  ["POST", "/sessions/{id}/label", "labelSessionEntry"],
  ["POST", "/sessions/{id}/leaf", "moveSessionLeaf"],
  ["GET", "/sessions/{id}/changes", "readSessionChanges"],
  ["GET", "/sessions/{id}/changes/file", "readChangedFile"],
  ["POST", "/sessions/{id}/model", "setSessionModel"],
  ["POST", "/sessions/{id}/thinking", "setSessionThinking"],
  ["POST", "/sessions/{id}/effort", "setSessionEffort"],
  ["POST", "/sessions/{id}/compact", "compactSession"],
  ["POST", "/sessions/{id}/undo", "undoSession"],
  ["POST", "/sessions/{id}/redo", "redoSession"],
  ["GET", "/sessions/{id}/context", "readSessionContext"],
  ["GET", "/sessions/{id}/cost", "readSessionCost"],
  ["POST", "/sessions/{id}/export", "exportSession"],
  ["POST", "/sessions/{id}/rename", "renameSession"],
  ["POST", "/sessions/{id}/arc", "bindSessionArc"],
  ["POST", "/sessions/{id}/bot", "bindSessionBot"],
  ["POST", "/preset", "applyPreset"],
  ["GET", "/asks", "listAsks"],
  ["POST", "/asks/{callId}", "answerAsk"],
  ["GET", "/permissions", "listPermissions"],
  ["POST", "/permissions/workspace/revoke", "revokeWorkspaceGrant"],
  ["GET", "/memory", "readMemory"],
  ["GET", "/memory/inbox", "listMemoryInbox"],
  ["POST", "/memory/inbox/{id}/approve", "approveStagedItem"],
  ["POST", "/memory/inbox/{id}/discard", "discardStagedItem"],
  ["GET", "/memory/notes", "listMemoryNotes"],
  ["GET", "/memory/notes/{name}", "readMemoryNote"],
  ["GET", "/memory/daily", "listMemoryDailyDates"],
  ["GET", "/memory/daily/{date}", "readMemoryDaily"],
  ["GET", "/memory/ledger", "readMemoryLedger"],
  ["POST", "/memory/ledger/{id}/revert", "revertMemoryLedgerEntry"],
  ["POST", "/memory/ask", "askMemory"],
  ["GET", "/arcs", "listArcs"],
  ["POST", "/arcs", "createArc"],
  ["POST", "/arcs/{slug}/close", "closeArc"],
  ["POST", "/arcs/{slug}/abandon", "abandonArc"],
  ["GET", "/arcs/{slug}/airlock", "readAirlock"],
  ["POST", "/arcs/{slug}/airlock/candidates/{note}", "triageAirlockCandidate"],
  ["POST", "/arcs/{slug}/airlock/questions", "triageAirlockQuestion"],
  ["POST", "/arcs/{slug}/airlock/deliver", "deliverAirlock"],
  ["POST", "/arcs/{slug}/airlock/finish", "finishAirlock"],
  ["GET", "/workspace", "readWorkspace"],
  ["POST", "/workspace/trust", "trustWorkspace"],
  ["GET", "/tree", "readTree"],
  ["GET", "/files", "readFile"],
  ["GET", "/mcp", "listMcpServers"],
  ["POST", "/mcp/{name}/restart", "restartMcpServer"],
  ["POST", "/mcp/{name}/enabled", "setMcpServerEnabled"],
  ["GET", "/mcp/{name}/tools", "listMcpServerTools"],
  ["GET", "/bots", "listBots"],
  ["POST", "/bots", "createBot"],
  ["GET", "/workspaces", "listWorkspaces"],
  ["POST", "/workspaces", "createWorkspace"],
  ["POST", "/workspaces/use", "useWorkspace"],
  ["POST", "/workspaces/{slug}/focus", "focusWorkspaceDir"],
  ["POST", "/workspaces/{slug}/unfocus", "unfocusWorkspaceDir"],
  ["GET", "/themes", "listThemes"],
  ["GET", "/trash", "listTrash"],
  ["POST", "/trash/{id}/restore", "restoreSession"],
  ["DELETE", "/trash/{id}", "discardTrashedSession"],
  ["DELETE", "/trash", "purgeTrash"],
] as const;

const eventsTheAppListensTo = [
  "turn.started",
  "turn.delta",
  "turn.completed",
  "turn.interrupted",
  "queue.changed",
  "tool.started",
  "tool.output",
  "tool.finished",
  "gate.ask",
  "gate.permission",
  "gate.preset",
  "session.mode",
  "context.injected",
  "diagnostics.published",
  "shell.reset",
  "extension.notice",
  "engine.error",
  "memory.inbox",
  "session.state",
  "surface.changed",
  "session.tree",
  "changes.updated",
  "session.removed",
  "session.restored",
  "session.settled",
] as const;

const tempDir = scratchDirs("keywork-app-contract-");
const userRoot = mkdtempSync(join(tmpdir(), "keywork-app-contract-user-"));
const stop = new AbortController();
let finished: Promise<number>;
let url = "";
let token = "";

beforeAll(async () => {
  const out: string[] = [];
  finished = serve({
    cwd: await tempDir(),
    sessionDir: await tempDir(),
    userRoot,
    projectTrusted: false,
    provider: new MockProvider([]),
    permissions: () => "allow",
    port: 0,
    ticketFile: join(await tempDir(), "server.json"),
    signal: stop.signal,
    print: (line) => out.push(line),
    printError: () => undefined,
  });
  while (out.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  url = out[0]?.replace("listening on ", "") ?? "";
  token = out[1]?.replace("token ", "") ?? "";
}, 30_000);

afterAll(async () => {
  stop.abort();
  await finished;
  await rm(userRoot, { recursive: true, force: true });
});

describe("a served keywork, as keywork-app attaches to it", () => {
  it("answers GET /doc without a token and names the contract major the app was built against", async () => {
    const response = await fetch(`${url}/doc`);
    expect(response.status).toBe(200);
    expect(majorOf(response.headers.get("x-keywork-contract"))).toBe(
      contractMajorTheAppBuildsAgainst,
    );
    const document = (await response.json()) as OpenApiDocument;
    expect(majorOf(document.info["x-keywork-contract"])).toBe(contractMajorTheAppBuildsAgainst);
    expect(document.info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("serves every path and operation the app calls, none of them deprecated", async () => {
    const document = (await (await fetch(`${url}/doc`)).json()) as OpenApiDocument;
    const missing = routesTheAppCalls.filter(([method, path, operationId]) => {
      const operation = document.paths[path]?.[lowercase(method)];
      return operation?.operationId !== operationId;
    });
    expect(missing).toEqual([]);
    const deprecated = routesTheAppCalls.filter(
      ([method, path]) => document.paths[path]?.[lowercase(method)]?.deprecated === true,
    );
    expect(deprecated).toEqual([]);
  });

  it("admits every event name the app listens to on the envelope's type enum", async () => {
    const document = (await (await fetch(`${url}/doc`)).json()) as OpenApiDocument;
    const envelope = document.components.schemas.BusEnvelope as {
      properties: { type: { enum: string[] } };
    };
    const unknown = eventsTheAppListensTo.filter(
      (name) => !envelope.properties.type.enum.includes(name),
    );
    expect(unknown).toEqual([]);
  });

  it("refuses an authenticated route without the ticket's token and answers with it", async () => {
    expect((await fetch(`${url}/sessions`)).status).toBe(401);
    const listed = await fetch(`${url}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
  });
});

function majorOf(contract: string | null | undefined): number {
  return Number.parseInt(contract?.split(".")[0] ?? "", 10);
}

function lowercase(method: "GET" | "POST" | "DELETE"): "get" | "post" | "delete" {
  return method.toLowerCase() as "get" | "post" | "delete";
}
