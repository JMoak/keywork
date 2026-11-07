import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedPath, readablePath, toolScope, withReadRoots } from "./confine.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

let scratch: string;
let workspace: string;
let payload: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-read-roots-"));
  workspace = join(scratch, "workspace");
  payload = join(scratch, "node", "outputs", "wren", "triage", "run-1.trigger.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(scratch, "node", "outputs", "wren", "triage"), { recursive: true });
  await writeFile(payload, '{ "kind": "webhook", "data": { "ref": "main" } }\n', "utf8");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("a read root beside the workspace scope", () => {
  it("lets the read tool open the one file it names and nothing around it", async () => {
    const scope = withReadRoots(toolScope(workspace), [payload]);
    expect(await readTool(scope).execute({ path: payload })).toContain('"ref": "main"');
    const sibling = join(scratch, "node", "outputs", "wren", "triage", "run-2.trigger.json");
    await writeFile(sibling, "{}\n", "utf8");
    await expect(readTool(scope).execute({ path: sibling })).rejects.toThrow(/escapes/);
  });

  it("widens reads only: the write and edit tools and confinedPath still refuse it", async () => {
    const scope = withReadRoots(toolScope(workspace), [payload]);
    expect(() => confinedPath(scope, payload)).toThrow(/escapes/);
    expect(readablePath(scope, payload)).toBe(payload);
    await expect(writeTool(scope).execute({ path: payload, content: "x" })).rejects.toThrow(
      /escapes/,
    );
    await expect(
      editTool(scope).execute({ path: payload, oldText: "main", newText: "x" }),
    ).rejects.toThrow(/escapes/);
  });

  it("leaves a scope alone when there is nothing to add", () => {
    const scope = toolScope(workspace);
    expect(withReadRoots(scope, [])).toBe(scope);
    expect(withReadRoots(scope, [payload, payload]).readRoots).toEqual([payload]);
  });
});
