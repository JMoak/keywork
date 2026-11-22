import { describe, expect, it } from "vitest";
import { nodeAccountAdr, privilegeRefusal } from "./account.ts";
import { launchArgv, selfLaunch, workspaceServeArgs } from "./launch.ts";

describe("privilegeRefusal", () => {
  it("refuses SYSTEM, the service accounts and the machine account on Windows", () => {
    for (const name of ["SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE", "MOAK-MAIN$"]) {
      const refusal = privilegeRefusal({ name, domain: "NT AUTHORITY", uid: null }, "win32");
      expect(refusal).toContain(nodeAccountAdr);
    }
  });

  it("refuses root on Linux and macOS, by uid or by name", () => {
    expect(privilegeRefusal({ name: "root", domain: null, uid: 0 }, "linux")).toContain(
      "never as root",
    );
    expect(privilegeRefusal({ name: "toor", domain: null, uid: 0 }, "darwin")).toContain(
      "never as root",
    );
  });
});

describe("selfLaunch", () => {
  it("runs the script through the runtime when keywork runs from source", () => {
    const launch = selfLaunch(
      "C:/bun/bun.exe",
      "C:/src/stead/repos/keywork/packages/cli/src/main.ts",
      () => true,
    );
    expect(launch).toEqual({
      program: "C:/bun/bun.exe",
      args: ["C:/src/stead/repos/keywork/packages/cli/src/main.ts"],
    });
    expect(launchArgv(launch, workspaceServeArgs("research"))).toEqual([
      "C:/bun/bun.exe",
      "C:/src/stead/repos/keywork/packages/cli/src/main.ts",
      "serve",
      "--port",
      "0",
      "--workspace",
      "research",
    ]);
  });
});
