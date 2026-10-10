import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import type { PromptOrigin } from "./bus.ts";
import { parseDocument } from "./memory/frontmatter.ts";
import { isStagedWrite, type StagedWrite } from "./memory/staging.ts";
import { MemoryStore } from "./memory/store.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import { toolScope } from "./tools/confine.ts";
import { coreTools } from "./tools/core.ts";

const scratch = scratchDirs("keywork-prompt-origin-");

const voice: PromptOrigin = { kind: "external", client: "wispr-flow" };

describe("a prompt's origin", () => {
  it("rides turn.started and the queue, and holds only while its turn runs", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("one"), textTurn("two")]) });
    const started: unknown[] = [];
    const queued: unknown[] = [];
    const seenDuringTurn: Array<PromptOrigin | undefined> = [];
    agent.bus.on("turn.started", (payload) => {
      started.push(payload);
      seenDuringTurn.push(agent.turnOrigin());
    });
    agent.bus.on("queue.changed", ({ queued: prompts }) => queued.push(prompts));

    const first = agent.send("typed");
    const second = agent.send("spoken", { origin: voice });
    await Promise.all([first, second]);

    expect(started).toEqual([{ userText: "typed" }, { userText: "spoken", origin: voice }]);
    expect(queued[0]).toEqual([
      { id: expect.any(String), text: "spoken", behavior: "queue", origin: voice },
    ]);
    expect(seenDuringTurn).toEqual([undefined, voice]);
    expect(agent.turnOrigin()).toBeUndefined();
  });

  it("stages a memory note from an external turn as untrusted and a typed one as agent", async () => {
    const root = await scratch();
    const vault = new MemoryStore({ vaultRoot: join(root, ".keywork", "memory"), trusted: true });
    const writeNote = (callId: string, title: string) =>
      toolCallTurn({
        type: "tool-call",
        callId,
        name: "write",
        arguments: { path: `.keywork/memory/${title}.md`, content: `${title} body\n` },
      });
    const agent: Agent = new Agent({
      provider: new MockProvider([
        writeNote("c1", "Spoken"),
        textTurn("noted"),
        writeNote("c2", "Typed"),
        textTurn("noted"),
      ]),
      tools: coreTools(toolScope(root), { vault, origin: () => agent.turnOrigin() }),
      permissions: () => "allow",
    });
    const outputs: string[] = [];
    agent.bus.on("tool.finished", ({ output }) => outputs.push(output));

    await agent.send("remember this", { origin: voice });
    await agent.send("remember that");

    expect(outputs[0]).toContain("with provenance untrusted");
    expect(outputs[1]).toContain("with provenance agent");
    const staged = (await vault.listStaged()).filter((item): item is StagedWrite =>
      isStagedWrite(item),
    );
    const provenanceOf = (target: string) => {
      const write = staged.find((item) => item.target === target);
      return write === undefined
        ? undefined
        : parseDocument(write.content, target).frontmatter.provenance;
    };
    expect(provenanceOf("Spoken.md")).toBe("untrusted");
    expect(provenanceOf("Typed.md")).toBe("agent");
  });
});
