import { CommandMissingError } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { bareHostLimitation, hostSubstrate } from "./host.ts";
import type { CliRunner } from "./runner.ts";
import { qualifiedSbxVersion, sbxMissing, sbxSubstrate } from "./sbx.ts";
import { fakeSbx, refusingSandboxHost } from "./testing.ts";
import { Workshops } from "./workshops.ts";

const scratch = scratchDirs("keywork-workshop-substrates-");

const missingSbx: CliRunner = async () => {
  throw new CommandMissingError("sbx");
};

async function node(run: CliRunner) {
  const stateDir = await scratch();
  return new Workshops({
    stateDir,
    substrates: {
      host: hostSubstrate({ stateDir, sandboxHost: refusingSandboxHost }),
      sbx: sbxSubstrate({ run, stateDir, pause: async () => undefined }),
    },
  });
}

describe("the substrates a node supports", () => {
  it("offers the qualified sbx first and the bare host with its limitation", async () => {
    const workshops = await node(fakeSbx().run);

    expect(await workshops.substrates()).toEqual({
      substrates: [
        {
          kind: "sbx",
          supported: true,
          version: qualifiedSbxVersion,
          reason: null,
          limitations: [],
        },
        {
          kind: "compose",
          supported: false,
          version: null,
          reason: "this node has no compose substrate",
          limitations: [],
        },
        {
          kind: "host",
          supported: true,
          version: null,
          reason: null,
          limitations: [bareHostLimitation],
        },
      ],
      preferred: "sbx",
    });
  });

  it("says sbx is missing in words the keeper can act on and prefers the host", async () => {
    const workshops = await node(missingSbx);

    const report = await workshops.substrates();

    expect(report.substrates[0]).toEqual({
      kind: "sbx",
      supported: false,
      version: null,
      reason: sbxMissing,
      limitations: [],
    });
    expect(report.preferred).toBe("host");
  });

  it("refuses an unqualified sbx by version", async () => {
    const workshops = await node(fakeSbx({ version: "0.46.0" }).run);

    const [sbx] = (await workshops.substrates()).substrates;

    expect(sbx).toMatchObject({ supported: false, reason: expect.stringContaining("0.46.0") });
  });

  it("refuses to raise a workshop on a substrate it does not support, before creating anything", async () => {
    const workshops = await node(missingSbx);

    expect(await workshops.create({ creature: "wren", substrate: "sbx" })).toEqual({
      refused: "unavailable",
      error: sbxMissing,
    });
    expect(await workshops.list()).toEqual([]);
  });
});
