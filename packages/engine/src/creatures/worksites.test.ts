import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { Part, Role } from "../messages.ts";
import type { SessionEntry } from "../session/entries.ts";
import { creatureWorksites, type JournalledConversation, worksitesFileIn } from "./worksites.ts";

const scratch = scratchDirs("keywork-creature-worksites-");

const asked = "2026-11-23T09:00:00.000Z";
const worked = "2026-11-23T09:01:00.000Z";

describe("the worksite tally", () => {
  it("counts each child folder a conversation changed a file in, and only the repository when it started in one", async () => {
    const base = await scratch();
    const [parent, repository, elsewhere] = ["parent", "repository", "zz-elsewhere"].map((name) =>
      join(base, name),
    ) as [string, string, string];
    for (const holding of [repository, elsewhere])
      await mkdir(join(holding, ".git"), { recursive: true });
    const tally = creatureWorksites({
      file: worksitesFileIn(await scratch()),
      creatures: { subscribe: () => () => {} },
      history: async () => ({
        conversations: [workIn(parent, "ada", elsewhere), workIn(repository, "pip", elsewhere)],
      }),
      notice: () => {},
    });

    expect(await tally.list()).toEqual([
      worksite("ada", join(parent, "alpha"), parent, worked),
      worksite("ada", join(parent, "beta"), parent, worked),
      worksite("ada", elsewhere, elsewhere, worked),
      worksite("pip", repository, repository, asked),
      worksite("pip", elsewhere, elsewhere, worked),
    ]);
  });
});

function workIn(root: string, creature: string, elsewhere: string): JournalledConversation {
  return {
    id: `${creature}-conversation`,
    creature,
    root,
    entries: [
      message("p1", "user", asked, [{ type: "text", text: "Tidy the notes in each project." }]),
      message("a1", "assistant", worked, [
        call("c1", "write", { path: "alpha/notes.md", content: "tidy\n" }),
        call("c2", "edit", { path: join(root, "beta", "plan.md"), oldText: "a", newText: "b" }),
        call("c3", "read", { path: "gamma/readme.md" }),
        call("c4", "bash", { command: "cd gamma && cat readme.md" }),
        call("c5", "write", { path: join(elsewhere, "notes", "today.md"), content: "out\n" }),
      ]),
      message("t1", "tool", worked, ["c1", "c2", "c3", "c4", "c5"].map(succeeded)),
    ],
  };
}

function worksite(creature: string, directory: string, root: string, since: string) {
  return {
    creature,
    directory,
    root,
    project: null,
    conversations: 1,
    since,
    latest: worked,
    active: false,
  };
}

function message(id: string, role: Role, timestamp: string, parts: Part[]): SessionEntry {
  return { type: "message", id, parentId: null, timestamp, message: { role, parts } };
}

function call(callId: string, name: string, args: unknown): Part {
  return { type: "tool-call", callId, name, arguments: args };
}

function succeeded(callId: string): Part {
  return { type: "tool-result", callId, output: "done", isError: false };
}
