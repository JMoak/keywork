import { strict as assert } from "node:assert";
import { newSessionFileName, scanSessions } from "../../../packages/cli/src/sessions/store.ts";
import {
  Agent,
  ChildSlots,
  childGuardOf,
  delegateTool,
  MockProvider,
  type SessionStore,
  textTurn,
  toolCallTurn,
} from "../../../packages/engine/src/index.ts";
import type { AgentFactory } from "../../../packages/tui/src/index.ts";
import { paneTitleCount } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { listTool } from "./fixtures.ts";

const greeting = "Ready when you are.";
const childAnswer = "There are 4 files here.";
const verdict = "The child counted 4 files.";
const childRow = /↳ child · count the files · \d+ms · done/;

const script = new MockProvider([
  textTurn(greeting),
  toolCallTurn({
    type: "tool-call",
    callId: "call-delegate",
    name: "delegate",
    arguments: { title: "count the files", prompt: "count the files in this workspace" },
  }),
  toolCallTurn({ type: "tool-call", callId: "call-list", name: "list", arguments: {} }),
  textTurn(childAnswer),
  textTurn(verdict),
]);

const parentHolder: { store: SessionStore | undefined } = { store: undefined };

const delegatingAgents: AgentFactory = (guard, history, seams) => {
  const slots = new ChildSlots();
  const parent: Agent = new Agent({
    provider: script,
    guard,
    ...(history !== undefined && { history }),
    ...(seams?.bus !== undefined && { bus: seams.bus }),
    tools: [
      listTool,
      delegateTool({
        host: {
          forge: ({ bus }) =>
            new Agent({ provider: script, tools: [listTool], guard: childGuardOf(guard), bus }),
        },
        slots,
        bots: [],
        parentBot: undefined,
        refusalEndsRun: false,
        parentStore: () => parentHolder.store,
        parentCall: () => parent.runningCall(),
        parentBus: () => parent.bus,
        reportActivity: (line) => parent.reportToolOutput(`${line}\n`),
        newSessionFileName,
      }),
    ],
  });
  return parent;
};

export const delegation: Scenario = {
  name: "delegation",
  description:
    "converse → the model delegates → the child row runs and settles in the parent's transcript → shift+tab cursors it → o opens the child session in its own pane",
  size: { width: 132, height: 32 },
  agentFactory: delegatingAgents,
  run: async (stage) => {
    await stage.settle();
    await stage.type("hello");
    await stage.press("enter");
    await stage.until(greeting);
    await stage.settle();
    const { stores } = await scanSessions(stage.sessionDir);
    parentHolder.store = stores[0];
    assert.ok(
      parentHolder.store !== undefined,
      "the parent session is on disk before it delegates",
    );

    await stage.type("count the files with a child");
    await stage.press("enter");
    await stage.until(verdict);
    const settled = await stage.until(childRow);
    assert.ok(!settled.includes("↳ child unsaved"), "the provenance line stays off the row");
    await stage.capture("child-row");

    await stage.press("shift+tab");
    await stage.until("o opens the child");
    await stage.capture("child-cursored");

    await stage.press("o");
    await stage.until(childAnswer);
    await stage.settle();
    const opened = await stage.capture("child-pane");
    assert.equal(paneTitleCount(opened), 1, "the parent pane keeps its session title");
    assert.ok(opened.includes("count the files"), "the child pane carries the child's title");
    await stage.quit();
  },
};
