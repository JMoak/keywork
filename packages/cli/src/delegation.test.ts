import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childDirFor,
  messageText,
  type PermissionResolver,
  SessionStore,
  type ToolCallPart,
  type ToolGuard,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type AgentCompositionOptions,
  type Composition,
  composeAgents,
  composeWorkspace,
  type DelegationHost,
} from "./compose.ts";
import { permissionsResolver } from "./presets.ts";

const tempDir = scratchDirs("keywork-delegation-");

function delegateCall(args: Record<string, unknown>): ToolCallPart {
  return { type: "tool-call", callId: "d1", name: "delegate", arguments: args };
}

const scouting = { title: "scout the repo", prompt: "list the top-level dirs" };

async function botAt(cwd: string, slug: string, frontmatter: string): Promise<void> {
  const dir = join(cwd, ".keywork", "bots", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "bot.md"), `---\n${frontmatter}\n---\n`);
}

interface Lineage {
  composition: Composition;
  parent: SessionStore;
  host: DelegationHost & { attached: string[]; released: string[] };
}

async function lineage(): Promise<Lineage> {
  const cwd = await tempDir();
  await botAt(cwd, "lead", "tools: [read, bash, delegate]");
  await botAt(cwd, "writer", "tools: [read, write]");
  await botAt(cwd, "careful", "deny: [bash]");
  const composition = await composeWorkspace({
    cwd,
    projectTrusted: true,
    userRoot: join(cwd, "user-keywork"),
    checkpoints: "off",
  });
  const parent = await SessionStore.create(join(cwd, "sessions", "parent.jsonl"), cwd);
  await parent.setName("parent");
  const attached: string[] = [];
  const released: string[] = [];
  const host = {
    attached,
    released,
    storeOf: (sessionId: string) => (sessionId === parent.header.id ? parent : undefined),
    attach: (child: SessionStore) => attached.push(child.header.id),
    release: (childId: string) => released.push(childId),
  };
  return { composition, parent, host };
}

async function onlyChild(parent: SessionStore): Promise<SessionStore> {
  const dir = childDirFor(parent.file);
  const [file] = await readdir(dir);
  if (file === undefined) throw new Error("no child session");
  return SessionStore.open(join(dir, file));
}

function toolNames(request: { tools: readonly { name: string }[] } | undefined): string[] {
  return request?.tools.map((tool) => tool.name) ?? [];
}

function build(
  family: Lineage,
  provider: ReturnType<typeof recordingProvider>,
  extras: { guard?: ToolGuard; bot?: string; options?: AgentCompositionOptions } = {},
) {
  return composeAgents(family.composition, { ...extras.options, delegation: family.host }).build({
    provider,
    guard: extras.guard ?? {},
    sessionId: family.parent.header.id,
    bot: family.composition.extensions.bots.find((bot) => bot.name === extras.bot),
  });
}

describe("delegation in the composition", () => {
  it("offers delegate only where a host opts in, and never to the child it spawns", async () => {
    const family = await lineage();
    const provider = recordingProvider([
      toolCallTurn(delegateCall(scouting)),
      textTurn("src, docs, scripts"),
      textTurn("three dirs"),
    ]);

    await build(family, provider).send("what's here?");

    expect(toolNames(provider.requests[0])).toContain("delegate");
    expect(toolNames(provider.requests[1])).not.toContain("delegate");
    expect(toolNames(provider.requests[1])).toContain("read");
    const without = recordingProvider([textTurn("ok")]);
    await composeAgents(family.composition).build({ provider: without, guard: {} }).send("hi");
    expect(toolNames(without.requests[0])).not.toContain("delegate");
  });

  it("joins the child to the host like any session, binds it, and lets it go after", async () => {
    const family = await lineage();
    await family.parent.appendArcBinding("dock-v2");
    const provider = recordingProvider([
      toolCallTurn(delegateCall({ ...scouting, bot: "careful" })),
      textTurn("src"),
      textTurn("done"),
    ]);

    await build(family, provider).send("go");

    const child = await onlyChild(family.parent);
    expect(family.host.attached).toEqual([child.header.id]);
    expect(family.host.released).toEqual([child.header.id]);
    expect(child.header.spawnedBy).toEqual({ sessionId: family.parent.header.id, callId: "d1" });
    expect(child.binding()).toEqual({ arc: "dock-v2", bot: "careful" });
    expect(child.name()).toBe("scout the repo");
  });

  it("runs the child under the parent's permissions: a policy deny reaches the child", async () => {
    const family = await lineage();
    const denyBash: PermissionResolver = (call) => (call.name === "bash" ? "deny" : undefined);
    const provider = recordingProvider([
      toolCallTurn(delegateCall(scouting)),
      toolCallTurn({ type: "tool-call", callId: "b1", name: "bash", arguments: { command: "ls" } }),
      textTurn("bash was refused"),
      textTurn("the child could not list"),
    ]);

    await build(family, provider, { options: { permissions: denyBash } }).send("go");

    const child = await onlyChild(family.parent);
    const results = child
      .messages()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result");
    expect(results).toEqual([
      expect.objectContaining({
        callId: "b1",
        output: "denied by permission policy",
        isError: true,
      }),
    ]);
  });

  it("never widens a bot: the child's tools stay inside the parent bot's allowlist", async () => {
    const family = await lineage();
    const provider = recordingProvider([
      toolCallTurn(delegateCall({ ...scouting, bot: "writer" })),
      textTurn("read only, as it turns out"),
      textTurn("ok"),
    ]);

    await build(family, provider, { bot: "lead" }).send("go");

    expect(toolNames(provider.requests[0])).toEqual(["read", "bash", "delegate"]);
    expect(toolNames(provider.requests[1])).toEqual(["read"]);
  });

  it("narrows further with the child bot's own rules", async () => {
    const family = await lineage();
    const provider = recordingProvider([
      toolCallTurn(delegateCall({ ...scouting, bot: "careful" })),
      toolCallTurn({ type: "tool-call", callId: "b1", name: "bash", arguments: { command: "ls" } }),
      textTurn("no bash for me"),
      textTurn("ok"),
    ]);
    const allowAll: PermissionResolver = () => "allow";

    await build(family, provider, { options: { permissions: allowAll } }).send("go");

    const child = await onlyChild(family.parent);
    const refused = child
      .messages()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-result");
    expect(refused).toMatchObject({ output: "denied by permission policy", isError: true });
  });

  it("turns off with one rule in the permission list, before any child exists", async () => {
    const family = await lineage();
    const denyDelegation = permissionsResolver([
      { action: "delegate", resource: "*", effect: "deny" },
    ]);
    const provider = recordingProvider([toolCallTurn(delegateCall(scouting)), textTurn("alone")]);

    const reply = await build(family, provider, { options: { permissions: denyDelegation } }).send(
      "go",
    );

    expect(messageText(reply)).toBe("alone");
    expect(provider.requests).toHaveLength(2);
    expect(family.host.attached).toEqual([]);
  });

  it("asks the parent's guard about a child's call and never starts a turn of its own", async () => {
    const family = await lineage();
    const asked: string[] = [];
    let turnsBegun = 0;
    const guard: ToolGuard = {
      confirm: async (call) => {
        asked.push(`${call.name} ${JSON.stringify(call.arguments)}`);
        return false;
      },
      beforeTurn: () => {
        turnsBegun += 1;
      },
    };
    const provider = recordingProvider([
      toolCallTurn(delegateCall(scouting)),
      toolCallTurn({ type: "tool-call", callId: "w1", name: "write", arguments: { path: "x" } }),
      textTurn("you said no"),
      textTurn("fine"),
    ]);

    const reply = await build(family, provider, { guard }).send("go");

    expect(asked).toEqual(['write {"path":"x"}']);
    expect(turnsBegun).toBe(1);
    expect(messageText(reply)).toBe("fine");
  });
});
