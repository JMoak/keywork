import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallPart } from "@keywork/engine";
import { type PermissionsConfig, permissionPresets } from "@keywork/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPresetSwitch,
  presetCommand,
  presetListing,
  presetResolver,
  presetsPortFor,
  userPresetSwitch,
} from "./presets.ts";
import { updateUserConfig } from "./user-config.ts";

const tempDirs: string[] = [];
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "keywork-presets-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterAll(async () => {
  process.env.HOME = savedHome.HOME;
  process.env.USERPROFILE = savedHome.USERPROFILE;
  await rm(home, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-presets-"));
  tempDirs.push(dir);
  return dir;
}

function bashCall(command: string): ToolCallPart {
  return { type: "tool-call", callId: "c1", name: "bash", arguments: { command } };
}

describe("createPresetSwitch", () => {
  it("starts on standard with an empty config and applies open live", async () => {
    const persisted: PermissionsConfig[] = [];
    const presets = createPresetSwitch({
      initial: undefined,
      persist: async (permissions) => {
        persisted.push(permissions);
      },
    });
    expect(presets.active()).toBe("standard");
    expect(presets.resolver(bashCall("rm -rf /"))).toBeUndefined();
    await presets.apply("open");
    expect(presets.active()).toBe("open");
    expect(presets.resolver(bashCall("rm -rf /"))).toBe("allow");
    expect(persisted).toEqual([permissionPresets.open]);
  });

  it("recognizes a hand-edited matrix as custom, never a preset's name", () => {
    const presets = createPresetSwitch({
      initial: { tools: { bash: "deny" } },
      persist: async () => {},
    });
    expect(presets.active()).toBe("custom");
  });

  it("tightens immediately when a persisted careful preset takes over", async () => {
    const presets = createPresetSwitch({ initial: undefined, persist: async () => {} });
    await presets.apply("careful");
    expect(presets.resolver(bashCall("ls"))).toBe("ask");
    expect(presets.active()).toBe("careful");
  });

  it("persists through updateUserConfig as the user-layer permissions section", async () => {
    const dir = await tempDir();
    const presets = createPresetSwitch({
      initial: undefined,
      persist: async (permissions) => {
        await updateUserConfig((existing) => ({ ...existing, permissions }), dir);
      },
    });
    await presets.apply("open");
    const openConfig = JSON.parse(await readFile(join(dir, "keywork.json"), "utf8"));
    expect(openConfig.permissions).toEqual(permissionPresets.open);
    await presets.apply("standard");
    const standardConfig = JSON.parse(await readFile(join(dir, "keywork.json"), "utf8"));
    expect(standardConfig.permissions).toEqual({});
  });
});

describe("userPresetSwitch", () => {
  it("persists an applied preset into the user's keywork.json", async () => {
    const presets = userPresetSwitch(undefined);
    await presets.apply("open");
    const saved = JSON.parse(await readFile(join(home, ".keywork", "keywork.json"), "utf8"));
    expect(saved.permissions).toEqual(permissionPresets.open);
    expect(presets.active()).toBe("open");
  });
});

describe("presetResolver", () => {
  it("resolves tool calls under one named preset without touching any config", () => {
    expect(presetResolver("open")(bashCall("rm -rf /"))).toBe("allow");
    expect(presetResolver("careful")(bashCall("ls"))).toBe("ask");
    expect(presetResolver("standard")(bashCall("rm -rf /"))).toBeUndefined();
  });
});

describe("presetsPortFor", () => {
  it("adapts a preset switch to the TUI port", async () => {
    const applied: string[] = [];
    const port = presetsPortFor({
      active: () => "standard",
      apply: async (name) => {
        applied.push(name);
      },
    });
    expect(port.names()).toEqual(["careful", "standard", "open"]);
    expect(port.active()).toBe("standard");
    expect(port.requiresConfirmation("open")).toBe(true);
    expect(port.requiresConfirmation("careful")).toBe(false);
    await port.apply("careful");
    expect(applied).toEqual(["careful"]);
  });
});

describe("presetCommand", () => {
  function harness(initial?: PermissionsConfig) {
    const lines: string[] = [];
    const questions: string[] = [];
    let answer = false;
    const presets = createPresetSwitch({ initial, persist: async () => {} });
    return {
      presets,
      lines,
      questions,
      answerWith: (value: boolean) => {
        answer = value;
      },
      run: (args: string) =>
        presetCommand(
          args,
          presets,
          (line) => lines.push(line),
          async (question) => {
            questions.push(question);
            return answer;
          },
        ),
    };
  }

  it("lists the presets with the active one marked", async () => {
    const world = harness();
    await world.run("");
    expect(world.lines).toEqual(["careful · standard* · open"]);
  });

  it("marks custom distinctly when the config diverges from every preset", async () => {
    const world = harness({ tools: { bash: "deny" } });
    await world.run("");
    expect(world.lines[0]).toContain("custom*");
    expect(world.lines[0]).not.toContain("standard*");
  });

  it("loosening asks first and a declined confirmation changes nothing", async () => {
    const world = harness();
    world.answerWith(false);
    await world.run("open");
    expect(world.questions).toHaveLength(1);
    expect(world.lines).toEqual(["left unchanged"]);
    expect(world.presets.active()).toBe("standard");
  });

  it("tightening applies without asking", async () => {
    const world = harness();
    await world.run("careful");
    expect(world.questions).toEqual([]);
    expect(world.presets.active()).toBe("careful");
  });

  it("rejects unknown names and reports when presets are unavailable", async () => {
    const world = harness();
    await world.run("yolo");
    expect(world.lines[0]).toContain('no preset named "yolo"');
    const lines: string[] = [];
    await presetCommand(
      "",
      undefined,
      (line) => lines.push(line),
      async () => true,
    );
    expect(lines).toEqual(["presets unavailable in this session"]);
  });
});

describe("presetListing", () => {
  it("annotates the custom state instead of lying with a preset name", () => {
    expect(presetListing("custom")).toContain("custom*");
    expect(presetListing("open")).toBe("careful · standard · open*");
  });
});
