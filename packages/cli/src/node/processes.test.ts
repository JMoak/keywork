import { describe, expect, it } from "vitest";
import { isProcessAlive, systemSpawner } from "./processes.ts";
import type { OutputStream } from "./supervisor.ts";

function nodeScript(source: string) {
  return {
    name: "probe",
    argv: [process.execPath, "-e", source],
    cwd: process.cwd(),
    env: { PROBE: "on" },
  };
}

describe("the system spawner", () => {
  it("streams a child's lines and reports its exit code", async () => {
    const lines: [OutputStream, string][] = [];
    const child = systemSpawner(
      nodeScript(
        "console.log('listening on http://127.0.0.1:1'); console.error(process.env.PROBE + ' ' + process.env.KEYWORK_NODE_UNIT); process.exit(3)",
      ),
      (stream, line) => lines.push([stream, line]),
    );
    expect(child.pid).toBeGreaterThan(0);
    expect(await child.exited).toEqual({ code: 3, signal: null });
    expect(lines).toContainEqual(["stdout", "listening on http://127.0.0.1:1"]);
    expect(lines).toContainEqual(["stderr", "on probe"]);
  });

  it("stops a child that would run forever", async () => {
    const child = systemSpawner(nodeScript("setInterval(() => {}, 1000)"), () => {});
    expect(isProcessAlive(child.pid ?? 0)).toBe(true);
    child.stop();
    const exit = await child.exited;
    expect(exit.code === null ? exit.signal : exit.code).not.toBe(0);
    expect(isProcessAlive(child.pid ?? 0)).toBe(false);
  });

  it("reports a program that does not exist as an exit without a code", async () => {
    const lines: string[] = [];
    const child = systemSpawner(
      { name: "ghost", argv: ["keywork-no-such-program-anywhere"], cwd: process.cwd() },
      (_stream, line) => lines.push(line),
    );
    expect(await child.exited).toEqual({ code: null, signal: null });
    expect(lines[0]).toContain("could not start keywork-no-such-program-anywhere");
  });
});
