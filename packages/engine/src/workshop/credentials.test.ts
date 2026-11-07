import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { detectShell } from "../tools/bash.ts";
import { findTool } from "../tools.ts";
import { brokerSentinel, environmentSecrets, modelProviderBrokers } from "./brokers.ts";
import { hostSubstrate } from "./host.ts";
import { sbxSubstrate } from "./sbx.ts";
import { workshopSpecSchema } from "./spec.ts";
import { fakeSbx, refusingSandboxHost } from "./testing.ts";
import { workshopTools } from "./tools.ts";

const tempDir = scratchDirs("keywork-workshop-credentials-");

const realAnthropicKey = "test-anthropic-key-7f3a9c1e5b";
const realOpenAiKey = "test-openai-key-2d8e6b4a0c";
const nodeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: realAnthropicKey,
  OPENAI_API_KEY: realOpenAiKey,
  AWS_SECRET_ACCESS_KEY: "test-aws-secret-91b2",
  GITHUB_TOKEN: "test-github-token-44c7",
};
const realValues = [
  realAnthropicKey,
  realOpenAiKey,
  "test-aws-secret-91b2",
  "test-github-token-44c7",
];
const brokers = modelProviderBrokers(environmentSecrets(nodeEnvironment));
const spec = (substrate: "host" | "sbx") =>
  workshopSpecSchema.parse({ creature: "pip", substrate, brokers: ["anthropic"] });

const shell = detectShell();
const printEnvironment =
  shell.name === "powershell"
    ? 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'
    : "env";

describe("a creature's tool call in a workshop", () => {
  it("never sees a real credential value on the bare host", async () => {
    const stateDir = await tempDir();
    const substrate = hostSubstrate({
      stateDir,
      brokers,
      environment: nodeEnvironment,
      sandboxHost: refusingSandboxHost,
      shell,
    });
    const workshop = await substrate.create(spec("host"));
    await substrate.start(workshop);
    const bash = findTool(workshopTools(substrate, workshop), "bash");

    const seen = await bash.execute({ command: printEnvironment });

    expect(seen).toContain(`ANTHROPIC_API_KEY=${brokerSentinel}`);
    for (const value of realValues) expect(seen).not.toContain(value);
  });

  it("cannot read the node's own files from the bare host's file tools", async () => {
    const stateDir = await tempDir();
    const secretFile = join(stateDir, "provider-keys.txt");
    await writeFile(secretFile, realAnthropicKey, "utf8");
    const substrate = hostSubstrate({ stateDir, brokers, sandboxHost: refusingSandboxHost });
    const workshop = await substrate.create(spec("host"));
    await substrate.start(workshop);
    const read = findTool(workshopTools(substrate, workshop), "read");

    await expect(read.execute({ path: secretFile })).rejects.toThrow();
    await expect(read.execute({ path: "../../../provider-keys.txt" })).rejects.toThrow();
  });

  it("never sees a real credential value in an sbx workshop, where the host proxy holds it", async () => {
    const sbx = fakeSbx();
    const substrate = sbxSubstrate({
      run: sbx.run,
      stateDir: await tempDir(),
      brokers,
      pause: async () => undefined,
    });
    const workshop = await substrate.create(spec("sbx"));
    await substrate.start(workshop);
    const bash = findTool(workshopTools(substrate, workshop), "bash");

    const seen = await bash.execute({ command: "env" });

    expect(seen).toMatch(/^ANTHROPIC_API_KEY=sbx-cs-[0-9a-f]{8}$/m);
    for (const value of realValues) expect(seen).not.toContain(value);
    expect(sbx.secrets).toEqual([
      {
        sandbox: workshop.handle,
        hosts: ["api.anthropic.com"],
        env: "ANTHROPIC_API_KEY",
        value: realAnthropicKey,
      },
    ]);
  });

  it("hands an sbx workshop's credential over on stdin only, never in an argument or env", async () => {
    const sbx = fakeSbx();
    const substrate = sbxSubstrate({
      run: sbx.run,
      stateDir: await tempDir(),
      brokers,
      pause: async () => undefined,
    });
    const workshop = await substrate.create(spec("sbx"));
    await substrate.start(workshop);
    await findTool(workshopTools(substrate, workshop), "bash").execute({ command: "pwd" });

    const visible = sbx.calls.map((call) => JSON.stringify([call.args, call.env ?? {}]));
    const carriers = sbx.calls.filter((call) => call.input?.includes(realAnthropicKey));

    for (const value of realValues) {
      for (const text of visible) expect(text).not.toContain(value);
    }
    expect(carriers.map((call) => call.args.slice(0, 2))).toEqual([["secret", "set-custom"]]);
  });
});
