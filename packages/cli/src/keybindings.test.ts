import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFileName, fileKeybindings, jsonSyntaxPosition } from "./keybindings.ts";

const roots: string[] = [];

function scratch(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "keywork-keybindings-"));
  roots.push(root);
  const userDir = join(root, "user");
  const projectDir = join(root, "project", ".keywork");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return { userDir, projectDir };
}

function writeConfig(dir: string, text: string): void {
  writeFileSync(join(dir, configFileName), text, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fileKeybindings", () => {
  it("reads the keybindings section from the layered config", async () => {
    const dirs = scratch();
    writeConfig(
      dirs.userDir,
      JSON.stringify({ flavor: "system", keybindings: { "app.quit": "ctrl+t" } }),
    );
    writeConfig(dirs.projectDir, JSON.stringify({ keybindings: { "pane.split": "ctrl+s" } }));
    const trusted = fileKeybindings({ ...dirs, projectTrusted: true });
    expect(await trusted.read()).toEqual({ "app.quit": "ctrl+t", "pane.split": "ctrl+s" });
    const untrusted = fileKeybindings({ ...dirs, projectTrusted: false });
    expect(await untrusted.read()).toEqual({ "app.quit": "ctrl+t" });
  });

  it("reads an empty map when no config exists yet", async () => {
    const dirs = scratch();
    expect(await fileKeybindings({ ...dirs, projectTrusted: true }).read()).toEqual({});
  });

  it("names the line and column of a JSON slip", async () => {
    const dirs = scratch();
    writeConfig(dirs.userDir, '{\n  "keybindings": {\n    "app.quit": tru\n  }\n}\n');
    await expect(fileKeybindings({ ...dirs, projectTrusted: false }).read()).rejects.toThrow(
      "keywork.json:3:17 is not valid JSON",
    );
  });

  it("relays a schema complaint on one line", async () => {
    const dirs = scratch();
    writeConfig(dirs.userDir, JSON.stringify({ keybindings: { "app.quit": 5 } }));
    await expect(fileKeybindings({ ...dirs, projectTrusted: false }).read()).rejects.toThrow(
      /^keywork\.json: [^\n]*keybindings[^\n]*$/,
    );
  });

  it("watches the config file in each layer it reads", () => {
    const dirs = scratch();
    const watched: string[] = [];
    const listeners = new Map<string, (fileName: string | undefined) => void>();
    let stops = 0;
    const source = fileKeybindings({
      ...dirs,
      projectTrusted: true,
      watchDirectory: (dir, onChange) => {
        watched.push(dir);
        listeners.set(dir, onChange);
        return () => {
          stops += 1;
        };
      },
    });
    let changes = 0;
    const unwatch = source.watch?.(() => {
      changes += 1;
    });
    expect(watched).toEqual([dirs.userDir, dirs.projectDir]);
    listeners.get(dirs.userDir)?.("auth.json");
    expect(changes).toBe(0);
    listeners.get(dirs.projectDir)?.(configFileName);
    listeners.get(dirs.userDir)?.(undefined);
    expect(changes).toBe(2);
    unwatch?.();
    expect(stops).toBe(2);
  });

  it("leaves an untrusted project layer unwatched", () => {
    const dirs = scratch();
    const watched: string[] = [];
    const source = fileKeybindings({
      ...dirs,
      projectTrusted: false,
      watchDirectory: (dir) => {
        watched.push(dir);
        return () => {};
      },
    });
    source.watch?.(() => {});
    expect(watched).toEqual([dirs.userDir]);
  });
});

describe("jsonSyntaxPosition", () => {
  it("returns nothing for well-formed JSON", () => {
    expect(jsonSyntaxPosition('{"a": [1, 2.5e3, "x\\"y", true, null], "b": {}}')).toBeUndefined();
    expect(jsonSyntaxPosition("  []  ")).toBeUndefined();
  });

  it("points at a trailing comma, a bare word, and an unterminated string", () => {
    expect(jsonSyntaxPosition('{\n  "a": 1,\n}')).toEqual({ line: 3, column: 1 });
    expect(jsonSyntaxPosition('{"a": tru}')).toEqual({ line: 1, column: 7 });
    expect(jsonSyntaxPosition('{"a": "open\n}')).toEqual({ line: 1, column: 12 });
  });

  it("points past a complete value at whatever follows it", () => {
    expect(jsonSyntaxPosition("{} {}")).toEqual({ line: 1, column: 4 });
  });
});
