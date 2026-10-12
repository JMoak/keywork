import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MockProvider,
  messageText,
  type SandboxHost,
  SandboxRefusal,
  type ToolCallPart,
  type ToolGuard,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { detectCapabilities, type WorkspacePort } from "@keywork/tui";
import { afterAll, describe, expect, it } from "vitest";
import { composeAgents, composeWorkspace } from "./compose.ts";
import { composePanes } from "./compose-panes.ts";
import { doctorReport, workspaceDoctorFacts } from "./doctor.ts";
import { createPresetSwitch } from "./presets.ts";
import { conclude, runHeadless } from "./run.ts";

const tempDir = scratchDirs("keywork-sandbox-");
const emptyUserRoot = mkdtempSync(join(tmpdir(), "keywork-sandbox-user-"));
const stateStore: WorkspacePort = { load: async () => undefined, save: () => {}, seal: () => {} };
const unsupportedHere = process.platform === "win32" || process.platform === "darwin";

afterAll(() => rm(emptyUserRoot, { recursive: true, force: true }));

function bashCall(command: string): ToolCallPart {
  return { type: "tool-call", callId: "call-1", name: "bash", arguments: { command } };
}

describe("a sandbox this host can't honour", () => {
  it.runIf(unsupportedHere)(
    "refuses headless commands, says why up front, and exits as denied",
    async () => {
      const cwd = await tempDir();
      const errors: string[] = [];
      const outcome = await runHeadless({
        prompt: "write a marker",
        cwd,
        json: false,
        userRoot: emptyUserRoot,
        sandbox: "workspace",
        permissions: () => "allow",
        provider: new MockProvider([
          toolCallTurn(bashCall("echo ran > marker.txt")),
          textTurn("done"),
        ]),
        print: () => {},
        printError: (line) => errors.push(line),
      });
      const exit = conclude(outcome, {
        json: false,
        print: () => {},
        printError: (line) => errors.push(line),
      });

      expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
      expect(outcome.outcome === "denied" && outcome.refused.map((call) => call.tool)).toEqual([
        "unconfined",
      ]);
      expect(exit).toBe(4);
      expect(errors[0]).toMatch(/^keywork run: sandbox workspace refused: \S/);
      expect(errors.at(-1)).toBe(
        `keywork run: the sandbox can't run on this host and no one could allow running unconfined, so every command was refused · set "sandbox": "off" in ~/.keywork/keywork.json or run where the sandbox can`,
      );
    },
  );

  it.runIf(unsupportedHere)(
    "asks once through the pane's guard, and a yes runs that workspace unconfined",
    async () => {
      const cwd = await tempDir();
      const asked: ToolCallPart[] = [];
      const notices: string[] = [];
      const guard: ToolGuard = {
        confirm: async (call) => {
          asked.push(call);
          return true;
        },
      };
      const composition = await composeWorkspace({
        cwd,
        projectTrusted: false,
        userRoot: emptyUserRoot,
        checkpoints: "off",
        sandbox: "workspace",
        notice: (text) => notices.push(text),
      });
      const agent = composeAgents(composition, { notice: (text) => notices.push(text) }).build({
        provider: new MockProvider([
          toolCallTurn(bashCall("echo first")),
          toolCallTurn({ ...bashCall("echo second"), callId: "call-2" }),
          textTurn("done"),
        ]),
        guard,
      });
      const outputs: string[] = [];
      agent.bus.on("tool.finished", (result) => outputs.push(result.output.trim()));

      const reply = await agent.send("run two commands");

      expect(messageText(reply)).toBe("done");
      expect(outputs).toEqual(["first", "second"]);
      expect(asked.map((call) => call.name)).toEqual(["bash", "unconfined", "bash"]);
      expect(notices[0]).toMatch(/^sandbox workspace refused: /);
      expect(notices[1]).toContain("allow runs commands unconfined until keywork exits");
    },
  );

  it.runIf(unsupportedHere)(
    "shows the refusal beside the preset word in the status bar",
    async () => {
      const root = await tempDir();
      const cwd = join(root, "workspace");
      await mkdir(cwd);
      const presets = createPresetSwitch({ initial: undefined, persist: async () => {} });
      const panes = (sandbox: "off" | "workspace") =>
        composePanes({
          cwd,
          projectTrusted: false,
          sessionDir: join(root, "sessions"),
          workspace: stateStore,
          config: { sandbox },
          presets,
          userRoot: join(root, "user"),
          checkpointsGitDir: join(root, "snapshots-git"),
        });
      const label = async (sandbox: "off" | "workspace") => {
        const status = (await panes(sandbox)).statusLabel;
        return typeof status === "function" ? status() : status;
      };

      expect(await label("off")).toBe("standard");
      expect(await label("workspace")).toBe("standard · sandbox workspace refused");
    },
  );
});

describe("keywork doctor", () => {
  const linuxHost = (trial: Awaited<ReturnType<SandboxHost["trial"]>>): SandboxHost => ({
    platform: "linux",
    home: "/home/kw",
    env: {},
    bubblewrap: () => "/usr/bin/bwrap",
    trial: async () => trial,
  });

  function sandboxRow(facts: Parameters<typeof doctorReport>[2]): string | undefined {
    const rows = doctorReport(
      detectCapabilities({ env: {}, platform: "linux" }),
      undefined,
      facts,
    ).rows;
    return rows.find((row) => row.label === "sandbox")?.value;
  }

  it("reports what the host can honour while the sandbox is off", async () => {
    const facts = await workspaceDoctorFacts("C:/nope", false, {}, linuxHost({ ok: true }));
    expect(sandboxRow(facts)).toBe("off · workspace and isolated available here");
  });

  it("reports the mode that is on and what it promises", async () => {
    const facts = await workspaceDoctorFacts(
      "C:/nope",
      false,
      { sandbox: "isolated" },
      linuxHost({ ok: true }),
    );
    expect(sandboxRow(facts)).toBe(
      "isolated · on · only the workspace is writable, temp is private, and there's no network",
    );
  });

  it("reports a refused mode with the fact and the fix", async () => {
    const stderr = "bwrap: setting up uid map: Permission denied";
    const facts = await workspaceDoctorFacts(
      "C:/nope",
      false,
      { sandbox: "workspace" },
      linuxHost({ ok: false, stderr }),
    );
    expect(sandboxRow(facts)).toMatch(
      /^workspace · refused · bubblewrap can't create a namespace here · on ubuntu 24\.04/,
    );
  });

  it("says plainly when the host can't sandbox at all", () => {
    const refusal = new SandboxRefusal("workspace", "windows has no sandbox keywork can use", "x");
    expect(
      sandboxRow({
        sandbox: { setting: "off", support: { workspace: refusal, isolated: refusal } },
      }),
    ).toBe("off · workspace and isolated refused here: windows has no sandbox keywork can use");
  });
});
