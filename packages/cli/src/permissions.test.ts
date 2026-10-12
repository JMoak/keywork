import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { workspaceIdentity, workspacePermissionsFile } from "./paths.ts";
import { permissionsCommand } from "./permissions.ts";

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

  it("asks a running server for its session grants", async () => {
    const { cwd, userRoot, projectTrusted } = await roots();
    const io = recorder();
    const seen: string[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
      return Response.json({
        trusted: true,
        bundle: [],
        workspace: [],
        session: {
          "session-1": [{ action: "bash", resource: "npm run *", effect: "allow" }],
          "session-2": [],
        },
      });
    }) as typeof fetch;

    await permissionsCommand([], { cwd, userRoot, projectTrusted }, io, {
      runningServer: async () => ({ url: "http://127.0.0.1:4100/", token: "t0k" }),
      fetch: fetchStub,
    });

    expect(seen).toEqual(["http://127.0.0.1:4100/permissions Bearer t0k"]);
    expect(io.out.slice(-3)).toEqual([
      "session grants · from the server at http://127.0.0.1:4100",
      "  session-1",
      "    bash npm run *",
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
