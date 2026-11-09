import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { ChangedPath } from "../checkpoints.ts";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";
import { recordTurnFacts, sessionFilesAt, type TurnTrees } from "./turn-facts.ts";

const tempDir = scratchDirs("keywork-turn-facts-");

describe("sessionFilesAt", () => {
  it("credits each changed file to the last turn on the active path, so a rewound turn claims nothing", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
    await turn(store, "first", "tree-before-first", [changed("a.txt", 1, 0)]);
    await turn(store, "just talking", undefined, []);
    const third = await turn(store, "third", "tree-before-third", [
      changed("b.txt", 1, 0),
      changed("a.txt", 1, 1),
    ]);
    store.branch(third.parentId ?? "");

    const files = await sessionFilesAt(
      diffingTo("tree-now", [
        changed("a.txt", 1, 0),
        changed("b.txt", 1, 0),
        changed("notes.md", 2, 0),
      ]),
      { store },
      "tree-now",
    );

    expect(files).toEqual([{ path: "a.txt", added: 1, deleted: 0, turn: 1 }]);
  });
});

async function turn(
  store: SessionStore,
  prompt: string,
  checkpoint: string | undefined,
  files: ChangedPath[],
) {
  const entry = await store.append(textMessage("user", prompt), undefined, checkpoint);
  await store.append(textMessage("assistant", `re: ${prompt}`));
  await recordTurnFacts(store, {
    prompt: entry.id,
    ...(checkpoint !== undefined && { checkpoint }),
    files,
  });
  return entry;
}

function changed(path: string, added: number, deleted: number): ChangedPath {
  return { path, added, deleted };
}

function diffingTo(now: string, files: ChangedPath[]): TurnTrees {
  return {
    snapshot: async () => now,
    filesBetween: async (from, to) => (from === "tree-before-first" && to === now ? files : []),
  };
}
