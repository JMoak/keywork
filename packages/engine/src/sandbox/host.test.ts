import { describe, expect, it } from "vitest";
import { toolScope } from "../tools/confine.ts";
import { type SandboxHost, sandboxFor, sandboxSupport, type TrialOutcome } from "./host.ts";
import { SandboxRefusal, unconfined } from "./sandbox.ts";

const scope = toolScope(process.cwd());
const launch = { file: "/bin/sh", args: ["-c", "true"], cwd: "/work", env: {} };

interface FakeHost extends SandboxHost {
  readonly trials: string[][];
  readonly lookups: () => number;
}

interface HostShape {
  missingBubblewrap?: boolean;
  trial?: TrialOutcome;
}

function fakeHost(platform: NodeJS.Platform, shape: HostShape = {}): FakeHost {
  const trials: string[][] = [];
  let lookups = 0;
  return {
    platform,
    home: "/home/kw",
    env: {},
    trials,
    lookups: () => lookups,
    bubblewrap: () => {
      lookups += 1;
      return shape.missingBubblewrap === true ? undefined : "/usr/bin/bwrap";
    },
    trial: async (_bubblewrap, args) => {
      trials.push([...args]);
      return shape.trial ?? { ok: true };
    },
  };
}

async function refusalOn(host: SandboxHost): Promise<SandboxRefusal> {
  const sandbox = await sandboxFor("workspace", scope, host);
  if (sandbox.refusal === undefined) throw new Error("expected the host to refuse");
  return sandbox.refusal;
}

describe("sandboxFor", () => {
  it("runs nothing and touches nothing when the sandbox is off", async () => {
    const host = fakeHost("linux");

    expect(await sandboxFor("off", scope, host)).toBe(unconfined);
    expect(host.lookups()).toBe(0);
    expect(host.trials).toEqual([]);
  });

  it("refuses on windows with a reason the user can act on, and never looks for bubblewrap", async () => {
    const host = fakeHost("win32");
    const sandbox = await sandboxFor("workspace", scope, host);

    expect(sandbox.mode).toBe("workspace");
    expect(sandbox.refusal?.message).toBe(
      'sandbox workspace refused: windows has no sandbox keywork can use · run keywork inside wsl2 or set "sandbox": "off" in ~/.keywork/keywork.json',
    );
    expect(() => sandbox.confine(launch)).toThrow(SandboxRefusal);
    expect(host.lookups()).toBe(0);
  });

  it("refuses on macos until its runner exists", async () => {
    expect((await refusalOn(fakeHost("darwin"))).fact).toBe("the macos sandbox isn't built yet");
  });

  it("refuses on linux without bubblewrap and says how to get it", async () => {
    const refusal = await refusalOn(fakeHost("linux", { missingBubblewrap: true }));

    expect(refusal.fact).toBe("bubblewrap isn't installed");
    expect(refusal.remedy).toContain("apt install bubblewrap");
  });

  it("names the namespace block when the trial run can't make a user namespace", async () => {
    const stderr = "bwrap: setting up uid map: Permission denied\n";
    const refusal = await refusalOn(fakeHost("linux", { trial: { ok: false, stderr } }));

    expect(refusal.fact).toBe("bubblewrap can't create a namespace here");
    expect(refusal.remedy).toContain("apparmor");
  });

  it("passes any other trial failure through in its own words", async () => {
    const stderr = "bwrap: execvp true: No such file or directory\nmore";
    const refusal = await refusalOn(fakeHost("linux", { trial: { ok: false, stderr } }));

    expect(refusal.fact).toBe("bubblewrap failed: bwrap: execvp true: No such file or directory");
  });

  it("confines through bubblewrap once the trial run passes", async () => {
    const host = fakeHost("linux");
    const sandbox = await sandboxFor("workspace", scope, host);
    const confined = sandbox.confine(launch);

    expect(sandbox.refusal).toBeUndefined();
    expect(confined.file).toBe("/usr/bin/bwrap");
    expect(confined.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "true"]);
    expect(host.trials[0]).not.toContain("--unshare-net");
  });

  it("trials isolated with the network namespace it will need", async () => {
    const host = fakeHost("linux");
    await sandboxFor("isolated", scope, host);

    expect(host.trials[0]).toContain("--unshare-net");
  });
});

describe("sandboxSupport", () => {
  it("reports each mode the host can and can't honour", async () => {
    const support = await sandboxSupport(fakeHost("linux"));

    expect(support).toEqual({ workspace: undefined, isolated: undefined });
    expect((await sandboxSupport(fakeHost("win32"))).isolated?.fact).toBe(
      "windows has no sandbox keywork can use",
    );
  });
});
