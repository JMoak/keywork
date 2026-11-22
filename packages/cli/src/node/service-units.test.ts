import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Registration } from "./manager.ts";
import { defaultUnitName, systemdArgument, systemdUnit, systemdUnitDir } from "./systemd.ts";
import { linuxKeeper } from "./testing.ts";

function registration(name: string, overrides: Partial<Registration> = {}): Registration {
  return {
    name,
    launch: {
      program: "/home/keeper/.bun/bin/bun",
      args: ["/home/keeper/src/stead/repos/keywork/packages/cli/src/main.ts"],
    },
    args: ["node", "run", "--supervise"],
    workingDirectory: "/home/keeper/.keywork/node",
    account: linuxKeeper,
    path: "/home/keeper/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    logFile: "/home/keeper/.keywork/node/logs/service.log",
    ...overrides,
  };
}

describe("the systemd user unit", () => {
  it("quotes and escapes arguments the way systemd reads them", () => {
    expect(systemdArgument("/opt/my tools/bun")).toBe('"/opt/my tools/bun"');
    expect(systemdArgument("100%")).toBe("100%%");
    expect(systemdArgument("$HOME")).toBe("$$HOME");
    const spaced = systemdUnit(registration(defaultUnitName, { path: "/opt/my tools/bin:$X%" }));
    expect(spaced).toContain('Environment="PATH=/opt/my tools/bin:$X%%"');
  });

  it("lives under XDG_CONFIG_HOME when it is set", () => {
    expect(systemdUnitDir("/home/keeper", {})).toBe(
      join("/home/keeper", ".config", "systemd", "user"),
    );
    expect(systemdUnitDir("/home/keeper", { XDG_CONFIG_HOME: "/cfg" })).toBe(
      join("/cfg", "systemd", "user"),
    );
  });
});
