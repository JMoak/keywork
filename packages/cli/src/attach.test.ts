import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@keywork/engine";
import { createKeyworkServer, EventLog, type Fetch, writeServerTicket } from "@keywork/server";
import { memorySessionHost } from "@keywork/server/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attach, attachedLabel, choosePane, mountedWorkspace } from "./attach.ts";

const token = "attach-test-token";
const url = "http://127.0.0.1:4770";

function inMemoryServer() {
  const log = new EventLog();
  const host = memorySessionHost({ log, provider: new MockProvider([]) });
  const server = createKeyworkServer({ token, host, log, version: "test", url });
  const fetch: Fetch = (input, init) => server.fetch(new Request(input, init));
  return { server, fetch };
}

describe("choosePane", () => {
  it("mounts conversation by default and either attachable kind by name", () => {
    expect(choosePane(undefined)).toEqual({ kind: "mount", pane: "conversation" });
    expect(choosePane("conversation")).toEqual({ kind: "mount", pane: "conversation" });
    expect(choosePane("session-tree")).toEqual({ kind: "mount", pane: "session-tree" });
  });

  it.each(["browser", "file", "diff", "terminal"])("refuses %s for wanting local files", (name) => {
    const choice = choosePane(name);
    expect(choice.kind).toBe("refused");
    if (choice.kind === "refused") {
      expect(choice.usage).toBe(false);
      expect(choice.reason).toContain("reads local files");
    }
  });

  it.each(["memory", "mcp", "arcs", "workspaces"])(
    "refuses %s for wanting the workspace",
    (name) => {
      const choice = choosePane(name);
      if (choice.kind === "refused") expect(choice.reason).toContain("local workspace");
      else throw new Error("expected a refusal");
    },
  );

  it("treats an unknown kind as a usage error", () => {
    expect(choosePane("bogus")).toEqual({
      kind: "refused",
      usage: true,
      reason: 'no pane kind named "bogus" · attach mounts conversation or session-tree',
    });
  });
});

describe("attach", () => {
  let dir = "";
  const errors: string[] = [];
  const printError = (line: string): void => {
    errors.push(line);
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "keywork-attach-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("exits 1 naming the ticket file when there is no server ticket", async () => {
    const ticketFile = join(dir, "absent.json");
    const code = await attach({ pane: "conversation", ticketFile, printError });
    expect(code).toBe(1);
    expect(errors.at(-1)).toContain(`no server ticket at ${ticketFile}`);
    expect(errors.at(-1)).toContain("--url and --token");
  });

  it("exits 1 when the server cannot be reached", async () => {
    const code = await attach(
      { pane: "conversation", url, token, printError },
      {
        client: {
          fetch: () => Promise.reject(new Error("ECONNREFUSED")),
        },
      },
    );
    expect(code).toBe(1);
    expect(errors.at(-1)).toBe(`keywork attach: can't reach ${url} · ECONNREFUSED`);
  });

  it("exits 1 when the ticket's token is refused", async () => {
    const ticketFile = join(dir, "server.json");
    writeServerTicket(ticketFile, { url, token: "stale" });
    const { fetch } = inMemoryServer();
    const code = await attach(
      { pane: "conversation", ticketFile, printError },
      { client: { fetch } },
    );
    expect(code).toBe(1);
    expect(errors.at(-1)).toBe(`keywork attach: ${url} answered: the server refused the token`);
  });

  it("exits 1 when the requested session is not on the server", async () => {
    const { fetch } = inMemoryServer();
    const code = await attach(
      { pane: "session-tree", session: "ghost", url, token, printError },
      { client: { fetch } },
    );
    expect(code).toBe(1);
    expect(errors.at(-1)).toBe(`keywork attach: the server at ${url} has no session ghost`);
  });
});

describe("mounting surface", () => {
  it("labels the chrome with the server host", () => {
    expect(attachedLabel({ url: "http://127.0.0.1:4770" })).toBe("attached · 127.0.0.1:4770");
  });

  it("restores a single pane of the requested kind, bound to the session when given", async () => {
    const conversation = await mountedWorkspace("conversation", "abc").load();
    expect(conversation).toEqual({
      version: 2,
      layout: { tree: { kind: "leaf", id: "session-1" }, focused: "session-1" },
      panes: [{ id: "session-1", kind: "conversation", sessionId: "abc" }],
      held: [],
    });
    const tree = await mountedWorkspace("session-tree", undefined).load();
    expect(tree).toMatchObject({ panes: [{ id: "tree-1", kind: "session-tree" }] });
  });
});
