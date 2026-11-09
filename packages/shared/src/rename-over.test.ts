import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renameOver, renameOverSync } from "./rename-over.ts";
import { scratchDirs } from "./testing/index.ts";

const scratch = scratchDirs("keywork-rename-over-");

const heldFileCodes = ["EPERM", "EBUSY", "EACCES"] as const;

class RenameFailure extends Error {
  constructor(readonly code: string | undefined) {
    super(`${code ?? "no code"}: rename failed`);
  }
}

function failure(code?: string): RenameFailure {
  return new RenameFailure(code);
}

interface Rig {
  run(): Promise<void>;
  attempts(): number;
  pauses: number[];
  boundMs: number;
}

type RigFor = (
  failures: readonly RenameFailure[],
  platform?: NodeJS.Platform,
  afterwards?: RenameFailure,
) => Rig;

function scripted(failures: readonly RenameFailure[], afterwards: RenameFailure | undefined) {
  let attempts = 0;
  return {
    attempts: () => attempts,
    attempt: () => {
      attempts += 1;
      const next = failures[attempts - 1] ?? afterwards;
      if (next !== undefined) throw next;
    },
  };
}

const asyncRig: RigFor = (failures, platform, afterwards) => {
  const script = scripted(failures, afterwards);
  const pauses: number[] = [];
  return {
    pauses,
    attempts: script.attempts,
    boundMs: 1300,
    run: () =>
      renameOver(
        "from",
        "to",
        { rename: async () => script.attempt() },
        {
          platform,
          pause: async (milliseconds) => {
            pauses.push(milliseconds);
          },
        },
      ),
  };
};

const syncRig: RigFor = (failures, platform, afterwards) => {
  const script = scripted(failures, afterwards);
  const pauses: number[] = [];
  return {
    pauses,
    attempts: script.attempts,
    boundMs: 160,
    run: async () =>
      renameOverSync(
        "from",
        "to",
        { renameSync: () => script.attempt() },
        {
          platform,
          pause: (milliseconds) => {
            pauses.push(milliseconds);
          },
        },
      ),
  };
};

describe.each([
  ["renameOver", asyncRig],
  ["renameOverSync", syncRig],
] as const)("%s", (_name, rigFor) => {
  it.each(heldFileCodes)("rides out %s on Windows and lands the rename", async (code) => {
    const rig = rigFor([failure(code), failure(code)], "win32");
    await rig.run();
    expect(rig.attempts()).toBe(3);
    expect(rig.pauses).toHaveLength(2);
  });

  it("makes one attempt when nothing holds the file", async () => {
    const rig = rigFor([], "win32");
    await rig.run();
    expect(rig.attempts()).toBe(1);
    expect(rig.pauses).toEqual([]);
  });

  it("gives up within its bound, surfacing the first hold it met", async () => {
    const first = failure("EPERM");
    const rig = rigFor([first, failure("EBUSY")], "win32", failure("EPERM"));
    await expect(rig.run()).rejects.toBe(first);
    expect(rig.attempts()).toBe(rig.pauses.length + 1);
    expect(rig.pauses.length).toBeGreaterThan(0);
    expect(rig.pauses.reduce((total, pause) => total + pause, 0)).toBeLessThanOrEqual(rig.boundMs);
  });

  it.each(["ENOENT", "ENOSPC", "EXDEV", "EISDIR", undefined])(
    "surfaces %s at once and never retries it",
    async (code) => {
      const original = failure(code);
      const rig = rigFor([original], "win32");
      await expect(rig.run()).rejects.toBe(original);
      expect(rig.attempts()).toBe(1);
      expect(rig.pauses).toEqual([]);
    },
  );

  it("surfaces a real failure that follows a hold as itself", async () => {
    const vanished = failure("ENOENT");
    const rig = rigFor([failure("EPERM"), vanished], "win32");
    await expect(rig.run()).rejects.toBe(vanished);
    expect(rig.attempts()).toBe(2);
    expect(rig.pauses).toHaveLength(1);
  });

  it.each(heldFileCodes)("treats %s as a real error off Windows", async (code) => {
    for (const platform of ["linux", "darwin"] as const) {
      const original = failure(code);
      const rig = rigFor([original], platform);
      await expect(rig.run()).rejects.toBe(original);
      expect(rig.attempts()).toBe(1);
      expect(rig.pauses).toEqual([]);
    }
  });

  it("asks the running platform when none is given", async () => {
    const original = failure("EPERM");
    const rig = rigFor([original]);
    if (process.platform === "win32") {
      await rig.run();
      expect(rig.pauses).toHaveLength(1);
    } else {
      await expect(rig.run()).rejects.toBe(original);
      expect(rig.pauses).toEqual([]);
    }
  });
});

function stagedOver(target: string): string {
  writeFileSync(target, "old");
  const staging = `${target}.staging`;
  writeFileSync(staging, "new");
  return staging;
}

describe.runIf(process.platform === "win32")("renaming over a file a real handle holds", () => {
  it("waits out the handle and replaces the file once it closes", async () => {
    const target = join(await scratch(), "curation.md");
    const staging = stagedOver(target);
    const handle = await open(target, "r");
    const pauses: number[] = [];

    await renameOver(staging, target, undefined, {
      pause: async (milliseconds) => {
        pauses.push(milliseconds);
        await handle.close();
      },
    });

    expect(pauses).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("waits out the handle synchronously too", async () => {
    const target = join(await scratch(), "settings.json");
    const staging = stagedOver(target);
    const descriptor = openSync(target, "r");
    const pauses: number[] = [];

    renameOverSync(staging, target, undefined, {
      pause: (milliseconds) => {
        pauses.push(milliseconds);
        closeSync(descriptor);
      },
    });

    expect(pauses).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("surfaces the hold and keeps the old file when the handle never lets go", async () => {
    const target = join(await scratch(), "curation.md");
    const staging = stagedOver(target);
    const handle = await open(target, "r");

    await expect(
      renameOver(staging, target, undefined, { pause: async () => undefined }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/) });

    await handle.close();
    expect(readFileSync(target, "utf8")).toBe("old");
  });
});
