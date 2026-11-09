import * as fs from "node:fs";
import { basename, join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../routines/testing.ts";
import {
  keptSettingsOf,
  keptSettingsText,
  type SettingDisk,
  settingFile,
  settingsFileIn,
} from "./file.ts";
import { type KeptSettings, nothingKept } from "./kept.ts";
import type { Setting } from "./setting.ts";
import { SettingStore, type ShowProposal } from "./store.ts";

const scratch = scratchDirs("keywork-show-file-");

const t0 = Date.parse("2026-11-08T09:00:00Z");

const plan: Setting = {
  id: "0b4f1c1e-2d1b-4c9e-9a57-3f1f6f0c2a10",
  creature: "wren",
  sessionId: "s1",
  what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
  rung: "card",
  why: "The plan changed under the tests you asked about.",
  at: "2026-11-08T09:00:00.000Z",
  until: "seen",
  state: "pinned",
  from: null,
  origin: "creature",
  replaces: null,
};

const opening: Setting = {
  ...plan,
  id: "7d0d8f3a-6b0e-4d55-8a3e-1c2b3d4e5f60",
  creature: null,
  what: { kind: "url", ref: "https://example.com/r1" },
  rung: "unfold",
  why: "",
  until: "2026-11-08T10:00:00+01:00",
  state: "live",
  from: plan.id,
  origin: "keeper",
  replaces: "5a1b2c3d-0000-4000-8000-000000000000",
};

const kept: KeptSettings = {
  settings: [plan, opening],
  spent: [{ owner: "creature wren", at: "2026-11-08T09:00:00.000Z" }],
};

async function settingsPath(): Promise<string> {
  return settingsFileIn(await scratch());
}

function heardBy(lines: string[]) {
  return (line: string) => lines.push(line);
}

describe("the kept settings text", () => {
  it("is a versioned JSON document that reads back exactly, key for key", () => {
    const text = keptSettingsText(kept);

    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.stringify(keptSettingsOf(text))).toBe(JSON.stringify(kept));
  });

  it("refuses a document that is not kept settings, naming the first problem", () => {
    const withState = (state: string) =>
      JSON.stringify({ version: 1, settings: [{ ...plan, state }], spent: [] });

    expect(() => keptSettingsOf("{ not json")).toThrow(SyntaxError);
    expect(() => keptSettingsOf(withState("seen"))).toThrow(
      /^not kept settings: settings\.0\.state/,
    );
    expect(() => keptSettingsOf(JSON.stringify({ ...kept, version: 2 }))).toThrow(/version/);
    expect(() =>
      keptSettingsOf(
        JSON.stringify({ version: 1, settings: [{ ...plan, until: "later" }], spent: [] }),
      ),
    ).toThrow(/until is seen, rests or a time/);
    expect(() => keptSettingsOf("[]")).toThrow(/^not kept settings/);
  });
});

describe("a settings file", () => {
  it("lives in the workspace state, under show", () => {
    expect(settingsFileIn(join("state", "workspaces", "abc"))).toBe(
      join("state", "workspaces", "abc", "show", "settings.json"),
    );
  });

  it("loads nothing kept, quietly, before anything was saved", async () => {
    const lines: string[] = [];
    expect(settingFile({ file: await settingsPath(), notice: heardBy(lines) }).load()).toEqual(
      nothingKept,
    );
    expect(lines).toEqual([]);
  });

  it("loads exactly what it saved last", async () => {
    const file = await settingsPath();
    const storage = settingFile({ file, notice: () => undefined });
    storage.save({ settings: [plan], spent: [] });
    storage.save(kept);

    expect(settingFile({ file, notice: () => undefined }).load()).toEqual(kept);
    expect(fs.readFileSync(file, "utf8")).toBe(keptSettingsText(kept));
  });

  it.each([
    ["is not JSON", "{ not json"],
    [
      "holds a setting that settled",
      JSON.stringify({ ...kept, settings: [{ ...plan, state: "seen" }] }),
    ],
    ["comes from a later keywork", JSON.stringify({ ...kept, version: 2 })],
    ["is empty", ""],
  ])(
    "starts with none when the file %s, says so in one loud line and moves the file aside",
    async (_case, text) => {
      const file = await settingsPath();
      fs.mkdirSync(join(file, ".."), { recursive: true });
      fs.writeFileSync(file, text);
      const lines: string[] = [];
      const storage = settingFile({ file, notice: heardBy(lines) });

      expect(storage.load()).toEqual(nothingKept);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`the settings kept at ${file} are unreadable (`);
      expect(lines[0]).toContain(
        `the yard starts with none and it was moved to ${file}.unreadable`,
      );
      expect(lines[0]).not.toContain("\n");
      expect(fs.readFileSync(`${file}.unreadable`, "utf8")).toBe(text);

      storage.save(kept);
      expect(settingFile({ file, notice: heardBy(lines) }).load()).toEqual(kept);
      expect(lines).toHaveLength(1);
    },
  );

  it("starts with none, once, when the file cannot be read or moved, and never throws", async () => {
    const file = await settingsPath();
    fs.mkdirSync(file, { recursive: true });
    const lines: string[] = [];
    const unmovable: SettingDisk = {
      ...fs,
      renameSync: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };

    expect(settingFile({ file, notice: heardBy(lines), disk: unmovable }).load()).toEqual(
      nothingKept,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /are unreadable \(.+\); the yard starts with none and it could not be moved aside \(EPERM: operation not permitted\)$/,
    );
  });

  it("stages each save beside the file, syncs it to disk, then renames it into place", async () => {
    const file = await settingsPath();
    const calls: string[] = [];
    const named = (path: fs.PathLike) =>
      basename(String(path)).replace(/\.\d+\.[0-9a-f]+\.tmp$/, ".<staging>");
    const watched: SettingDisk = {
      ...fs,
      openSync: (path, flags, mode) => {
        calls.push(`open ${named(path)}`);
        return fs.openSync(path, flags, mode);
      },
      fsyncSync: (descriptor) => {
        calls.push("sync");
        fs.fsyncSync(descriptor);
      },
      renameSync: (from, to) => {
        calls.push(`rename ${named(from)} to ${named(to)}`);
        fs.renameSync(from, to);
      },
    };

    settingFile({ file, notice: () => undefined, disk: watched }).save(kept);

    expect(calls).toEqual([
      "open settings.json.<staging>",
      "sync",
      "rename settings.json.<staging> to settings.json",
    ]);
    expect(fs.readdirSync(join(file, ".."))).toEqual(["settings.json"]);
  });

  it("says once that saving fails, until a save succeeds again", async () => {
    const file = await settingsPath();
    const lines: string[] = [];
    let failing = true;
    const flaky: SettingDisk = {
      ...fs,
      renameSync: (from, to) => {
        if (failing) throw new Error("EBUSY: resource busy or locked");
        fs.renameSync(from, to);
      },
    };
    const storage = settingFile({ file, notice: heardBy(lines), disk: flaky });

    storage.save(kept);
    storage.save(kept);
    failing = false;
    storage.save(kept);
    failing = true;
    storage.save(nothingKept);

    expect(lines).toEqual([
      `settings could not be saved to ${file} (EBUSY: resource busy or locked); they stay in memory and the next change saves them again`,
      `settings could not be saved to ${file} (EBUSY: resource busy or locked); they stay in memory and the next change saves them again`,
    ]);
    expect(fs.readdirSync(join(file, ".."))).toEqual(["settings.json"]);
    expect(settingFile({ file, notice: () => undefined }).load()).toEqual(kept);
  });
});

describe("a crash between writes", () => {
  const proposalOf = (what: ShowProposal["what"]): ShowProposal => ({
    creature: "wren",
    sessionId: "s1",
    what,
    rung: "card",
    why: "It matters now.",
    until: "seen",
    from: null,
    origin: "creature",
  });

  async function storeOver(file: string, disk: SettingDisk = fs) {
    return SettingStore.load({
      storage: settingFile({ file, notice: () => undefined, disk }),
      clock: new FakeClock(t0),
      emit: () => undefined,
      threads: async () => ({ creature: "wren", parent: null }),
    });
  }

  it.each([
    ["before the rename", "rename"],
    ["halfway through writing the staged file", "write"],
  ] as const)(
    "%s keeps the last whole file, so a pinned setting is never lost",
    async (_case, dies) => {
      const file = await settingsPath();
      const crash = new Error("the process died");
      const dying: SettingDisk = {
        ...fs,
        writeSync: ((descriptor: number, text: string) => {
          if (dies !== "write" || !text.includes("halfway")) return fs.writeSync(descriptor, text);
          fs.writeSync(descriptor, text.slice(0, text.length / 2));
          throw crash;
        }) as SettingDisk["writeSync"],
        renameSync: (from, to) => {
          if (dies === "rename" && fs.readFileSync(from, "utf8").includes("halfway")) throw crash;
          fs.renameSync(from, to);
        },
        rmSync: () => undefined,
      };
      const before = await storeOver(file, dying);
      const pinned = before.propose(proposalOf({ kind: "file", ref: "docs/plan.md" }));
      if ("refused" in pinned) throw new Error(pinned.error);
      before.answer(pinned.setting.id, "pinned");

      before.propose(proposalOf({ kind: "note", ref: "halfway" }));
      before.close();
      const staged = fs.readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"));

      const after = await storeOver(file);

      expect(staged).toHaveLength(1);
      expect(after.open()).toEqual([{ ...pinned.setting, state: "pinned" }]);
      expect(fs.readdirSync(join(file, ".."))).toEqual(["settings.json"]);
    },
  );
});
