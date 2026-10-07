import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirs } from "../testing/index.ts";
import { CommandMissingError, type CommandResult, type CommandRunner } from "./command.ts";
import { revealServerSecrets, SecretNotFoundError } from "./refs.ts";
import { platformVault } from "./vault.ts";

const tempDir = scratchDirs("keywork-secrets-");

describe("platformVault on Linux (Secret Service via secret-tool)", () => {
  it("round-trips a key through secret-tool store / lookup / clear", async () => {
    const keyring = fakeSecretTool();
    const vault = platformVault({ dataDir: await tempDir(), platform: "linux", run: keyring.run });

    await vault?.store("provider.openai", "sk-live-123");

    expect(keyring.calls[0]).toEqual({
      command: "secret-tool",
      args: [
        "store",
        "--label=keywork provider.openai",
        "service",
        "keywork",
        "account",
        "provider.openai",
      ],
      input: "sk-live-123",
    });
    expect(await vault?.lookup("provider.openai")).toBe("sk-live-123");
    await vault?.forget("provider.openai");
    expect(await vault?.lookup("provider.openai")).toBeUndefined();
  });

  it("keeps the secret off the command line", async () => {
    const keyring = fakeSecretTool();
    const vault = platformVault({ dataDir: await tempDir(), platform: "linux", run: keyring.run });

    await vault?.store("token", "hunter2");

    expect(keyring.calls.flatMap((call) => call.args)).not.toContain("hunter2");
  });

  it("reports a missing secret-tool as a store error", async () => {
    const vault = platformVault({ dataDir: await tempDir(), platform: "linux", run: missing });

    await expect(vault?.store("token", "x")).rejects.toThrow(
      "secret service: secret-tool is not installed",
    );
  });

  it("reports a keyring that refuses the write", async () => {
    const run: CommandRunner = async () =>
      result(1, "", "Cannot autolaunch D-Bus without X11 $DISPLAY\n");
    const vault = platformVault({ dataDir: await tempDir(), platform: "linux", run });

    await expect(vault?.store("token", "x")).rejects.toThrow("Cannot autolaunch D-Bus");
  });
});

describe("platformVault on Windows (DPAPI via PowerShell)", () => {
  it("round-trips a key through a sealed file under the data dir", async () => {
    const dataDir = await tempDir();
    const powershell = fakeDpapi();
    const vault = platformVault({ dataDir, platform: "win32", run: powershell.run });

    await vault?.store("provider.anthropic", "sk-ant-ünïcode");

    expect(await readdir(join(dataDir, "secrets"))).toEqual(["provider.anthropic.dpapi"]);
    const sealed = await readFile(join(dataDir, "secrets", "provider.anthropic.dpapi"), "utf8");
    expect(sealed).not.toContain("sk-ant");
    expect(await vault?.lookup("provider.anthropic")).toBe("sk-ant-ünïcode");
    expect(powershell.calls.every((call) => call.args.includes("-NoProfile"))).toBe(true);
    expect(powershell.calls.flatMap((call) => call.args).join(" ")).not.toContain("sk-ant");

    await vault?.forget("provider.anthropic");
    expect(await vault?.lookup("provider.anthropic")).toBeUndefined();
  });

  it("answers undefined for a name it never stored without starting PowerShell", async () => {
    const powershell = fakeDpapi();
    const vault = platformVault({
      dataDir: await tempDir(),
      platform: "win32",
      run: powershell.run,
    });

    expect(await vault?.lookup("never")).toBeUndefined();
    expect(powershell.calls).toEqual([]);
  });

  it("reports a missing PowerShell as a store error", async () => {
    const vault = platformVault({ dataDir: await tempDir(), platform: "win32", run: missing });

    await expect(vault?.store("token", "x")).rejects.toThrow(
      "windows dpapi: powershell is not installed",
    );
  });

  it.runIf(process.platform === "win32")(
    "round-trips through the real DPAPI on this machine",
    async () => {
      const vault = platformVault({ dataDir: await tempDir() });
      const name = `keywork-test.${crypto.randomUUID()}`;
      try {
        await vault?.store(name, "throwaway-ünï-secret");
        expect(await vault?.lookup(name)).toBe("throwaway-ünï-secret");
      } finally {
        await vault?.forget(name);
      }
      expect(await vault?.lookup(name)).toBeUndefined();
    },
    20_000,
  );
});

describe("platformVault on macOS (Keychain via security)", () => {
  it("round-trips a key through add / find / delete-generic-password", async () => {
    const items = new Map<string, string>();
    const run: CommandRunner = async (_command, args) => {
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "add-generic-password")
        items.set(account, args[args.indexOf("-w") + 1] ?? "");
      if (args[0] === "find-generic-password") {
        const value = items.get(account);
        return value === undefined ? result(44) : result(0, `${value}\n`);
      }
      if (args[0] === "delete-generic-password") items.delete(account);
      return result(0);
    };
    const vault = platformVault({ dataDir: await tempDir(), platform: "darwin", run });

    await vault?.store("provider.openai", "sk-mac");

    expect(await vault?.lookup("provider.openai")).toBe("sk-mac");
    await vault?.forget("provider.openai");
    expect(await vault?.lookup("provider.openai")).toBeUndefined();
  });
});

describe("platformVault names", () => {
  it("has no backend on a platform without a known credential store", () => {
    expect(platformVault({ dataDir: ".", platform: "aix" })).toBeUndefined();
  });

  it("refuses names that could escape the store's namespace", async () => {
    const vault = platformVault({ dataDir: await tempDir(), platform: "win32", run: missing });

    await expect(vault?.store("../evil", "x")).rejects.toThrow("secret names are");
  });
});

describe("revealServerSecrets", () => {
  it("swaps secret: references in env and headers for the stored values", async () => {
    const keyring = fakeSecretTool();
    const vault = platformVault({ dataDir: await tempDir(), platform: "linux", run: keyring.run });
    await vault?.store("github-token", "ghp_abc");

    const stdio = await revealServerSecrets(
      { transport: "stdio", command: "gh-mcp", env: { TOKEN: "secret:github-token", MODE: "ro" } },
      vault,
    );
    const http = await revealServerSecrets(
      {
        transport: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "secret:github-token" },
      },
      vault,
    );

    expect(stdio).toMatchObject({ env: { TOKEN: "ghp_abc", MODE: "ro" } });
    expect(http).toMatchObject({ headers: { Authorization: "ghp_abc" } });
  });

  it("names the missing secret without echoing any value", async () => {
    const vault = platformVault({
      dataDir: await tempDir(),
      platform: "linux",
      run: fakeSecretTool().run,
    });

    await expect(
      revealServerSecrets(
        { transport: "stdio", command: "x", env: { TOKEN: "secret:absent" } },
        vault,
      ),
    ).rejects.toThrow(new SecretNotFoundError("absent"));
  });
});

interface RecordedCall {
  command: string;
  args: readonly string[];
  input: string | undefined;
}

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

const missing: CommandRunner = async (command) => {
  throw new CommandMissingError(command);
};

function fakeSecretTool(): { run: CommandRunner; calls: RecordedCall[] } {
  const items = new Map<string, string>();
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    const account = args.at(-1) ?? "";
    switch (args[0]) {
      case "store":
        items.set(account, input ?? "");
        return result(0);
      case "lookup": {
        const value = items.get(account);
        return value === undefined ? result(1) : result(0, value);
      }
      case "clear":
        items.delete(account);
        return result(0);
      default:
        return result(2, "", "unknown command");
    }
  };
  return { run, calls };
}

function fakeDpapi(): { run: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    return result(0, `${reversed((input ?? "").trim())}\r\n`);
  };
  return { run, calls };
}

function reversed(text: string): string {
  return [...text].reverse().join("");
}
