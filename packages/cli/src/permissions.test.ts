import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, textTurn, toolCallTurn } from "@keywork/engine";
import { type KeyworkClient, keyworkClient, type PendingAsk } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { workspaceIdentity, workspacePermissionsFile } from "./paths.ts";
import { permissionsCommand } from "./permissions.ts";
import { runningServerAmong, serve } from "./serve.ts";

const scratch = scratchDirs("keywork-cli-permissions-");

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
  };
}

async function roots(trusted = true) {
  const cwd = await scratch();
  const userRoot = await scratch();
  return { cwd, userRoot, projectTrusted: trusted };
}

function seedGrants(cwd: string, userRoot: string, resources: readonly string[]): string {
  const file = workspacePermissionsFile(workspaceIdentity(cwd), userRoot);
  mkdirSync(join(file, ".."), { recursive: true });
  const rules = resources.map((resource) => ({ action: "bash", resource, effect: "allow" }));
  writeFileSync(file, JSON.stringify({ rules }));
  return file;
}

describe("keywork permissions list", () => {
  it("prints the fixed bundle, the workspace grants with their stamp, and where session grants live", async () => {
    const { cwd, userRoot, projectTrusted } = await roots();
    seedGrants(cwd, userRoot, ["git push *"]);
    const io = recorder();

    expect(await permissionsCommand([], { cwd, userRoot, projectTrusted }, io)).toBe(0);

    const text = io.out.join("\n");
    expect(io.out[0]).toBe("trusted reads · fixed in keywork, your own rules win over it");
    expect(io.out).toContain("  bash git status*");
    expect(io.out).toContain("  bash find *-delete*");
    expect(text).toMatch(/workspace grants · last changed \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(io.out).toContain("  bash git push *");
    expect(io.out.at(-1)).toBe(
      "session grants · live in the running app only · start keywork serve to list them",
    );
    expect(io.err).toEqual([]);
  });

  it("says the bundle is off for an untrusted folder and that no grants exist yet", async () => {
    const { cwd, userRoot } = await roots(false);
    const io = recorder();

    expect(await permissionsCommand(["list"], { cwd, userRoot, projectTrusted: false }, io)).toBe(
      0,
    );

    expect(io.out).toEqual([
      "trusted reads · off until this folder is trusted (keywork trust)",
      "",
      "workspace grants · none yet · answer an ask with workspace scope to add one",
      "",
      "session grants · live in the running app only · start keywork serve to list them",
    ]);
  });

  it("refuses a stray argument and an unknown verb with usage", async () => {
    const { cwd, userRoot, projectTrusted } = await roots();
    const io = recorder();
    expect(await permissionsCommand(["list", "extra"], { cwd, userRoot, projectTrusted }, io)).toBe(
      2,
    );
    expect(await permissionsCommand(["grant"], { cwd, userRoot, projectTrusted }, io)).toBe(2);
    expect(io.err[0]).toContain('unexpected argument "extra"');
    expect(io.err[1]).toContain('unknown verb "grant"');
  });
});

describe("keywork permissions revoke", () => {
  it("takes the rule as list prints it and writes the store the server reads", async () => {
    const { cwd, userRoot, projectTrusted } = await roots();
    const file = seedGrants(cwd, userRoot, ["git push *", "npm run *"]);
    const io = recorder();

    const code = await permissionsCommand(
      ["revoke", "bash", "git", "push", "*"],
      { cwd, userRoot, projectTrusted },
      io,
    );

    expect(code).toBe(0);
    expect(io.out).toEqual(["revoked bash git push * · it asks again from the next call on"]);
    const { rules } = JSON.parse(readFileSync(file, "utf8"));
    expect(rules).toEqual([{ action: "bash", resource: "npm run *", effect: "allow" }]);
  });

  it("reports a grant that is not there and a malformed rule", async () => {
    const { cwd, userRoot, projectTrusted } = await roots();
    seedGrants(cwd, userRoot, ["git push *"]);
    const io = recorder();

    expect(
      await permissionsCommand(["revoke", "bash", "rm *"], { cwd, userRoot, projectTrusted }, io),
    ).toBe(1);
    expect(io.err[0]).toBe('keywork permissions: no workspace grant reads "bash rm *"');

    expect(
      await permissionsCommand(["revoke", "bash"], { cwd, userRoot, projectTrusted }, io),
    ).toBe(2);
    expect(io.err[1]).toContain("revoke wants the grant as list prints it");
  });
});

describe("keywork permissions against a running keywork serve", () => {
  it("lists the server's grants and revokes a workspace grant through it", async () => {
    const { cwd, userRoot } = await roots(false);
    const served = await servedWith(
      cwd,
      userRoot,
      new MockProvider([bash("c1", "printf %s one"), bash("c2", "true"), textTurn("done")]),
    );
    const { client } = served;
    const session = await client.createSession();
    await client.prompt(session.id, "print");
    expect(await client.answerAsk((await nextAsk(client)).callId, "granted", "session")).toBe(
      "settled",
    );
    expect(await client.answerAsk((await nextAsk(client)).callId, "granted", "workspace")).toBe(
      "settled",
    );
    const cliRoots = { cwd, userRoot, projectTrusted: false };
    const listed = recorder();

    expect(await permissionsCommand([], cliRoots, listed, served.seams)).toBe(0);

    expect(listed.out[0]).toBe("trusted reads · fixed in keywork, your own rules win over it");
    expect(listed.out).toContain("  bash true *");
    expect(listed.out.slice(-3)).toEqual([
      `session grants · from the server at ${client.url}`,
      `  ${session.id}`,
      "    bash printf *",
    ]);

    const revoked = recorder();
    expect(
      await permissionsCommand(["revoke", "bash", "true *"], cliRoots, revoked, served.seams),
    ).toBe(0);
    expect(revoked.out).toEqual(["revoked bash true * · it asks again from the next call on"]);
    expect((await client.listPermissions()).workspace).toEqual([]);
    expect(
      await permissionsCommand(["revoke", "bash", "true *"], cliRoots, revoked, served.seams),
    ).toBe(1);
    expect(revoked.err).toEqual(['keywork permissions: no workspace grant reads "bash true *"']);
    await served.stop();
  });
});

const bash = (callId: string, command: string) =>
  toolCallTurn({ type: "tool-call", callId, name: "bash", arguments: { command } });

async function servedWith(cwd: string, userRoot: string, provider: MockProvider) {
  const ticketFile = join(await scratch(), "server.json");
  const stop = new AbortController();
  const finished = serve({
    cwd,
    userRoot,
    sessionDir: await scratch(),
    projectTrusted: true,
    provider,
    permissions: () => undefined,
    port: 0,
    ticketFile,
    signal: stop.signal,
    print: () => undefined,
    printError: () => undefined,
  });
  const runningServer = async (): Promise<KeyworkClient | undefined> => {
    const ticket = await runningServerAmong([ticketFile], fetch);
    return ticket === undefined ? undefined : keyworkClient(ticket);
  };
  const client = await eventually(runningServer);
  return {
    client,
    seams: { runningServer },
    stop: async () => {
      stop.abort();
      await finished;
    },
  };
}

async function nextAsk(client: KeyworkClient): Promise<PendingAsk> {
  return eventually(async () => (await client.asks())[0]);
}

async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("gave up waiting");
}
