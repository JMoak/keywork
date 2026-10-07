import {
  Agent,
  type Message,
  messageText,
  type Provider,
  type ProviderRequest,
  textTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  type CommitDraftDeps,
  commitDraftCommand,
  commitRequest,
  diffCharCap,
  draftCommit,
  type GitRunner,
  workingDiff,
} from "./commit-draft.ts";
import { ConversationModel } from "./conversation-model.ts";
import { copyToClipboard } from "./osc.ts";

const fixturePatch = [
  "diff --git a/src/parser.ts b/src/parser.ts",
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -1 +1 @@",
  "-const limit = 10;",
  "+const limit = 20;",
].join("\n");
const fixtureStat = " src/parser.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)";

function fakeGit(trees: { staged?: string; unstaged?: string }): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push([...args]);
    const staged = args.includes("--cached");
    const patch = (staged ? trees.staged : trees.unstaged) ?? "";
    return args.includes("--stat") ? (patch === "" ? "" : fixtureStat) : patch;
  };
  return { git, calls };
}

function recordingProvider(reply: string): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      name: "recording",
      async *stream(request) {
        requests.push(request);
        yield* textTurn(reply);
      },
    },
  };
}

function setup(reply: string, trees: { staged?: string; unstaged?: string }, clipboard = true) {
  const { provider, requests } = recordingProvider(reply);
  const model = new ConversationModel(new Agent({ provider }), () => {});
  const { git, calls } = fakeGit(trees);
  const written: string[] = [];
  const notices: string[] = [];
  const deps: CommitDraftDeps = {
    conversation: () => model,
    git,
    write: (bytes) => written.push(bytes),
    notice: (text) => notices.push(text),
    clipboard,
  };
  return { deps, model, requests, calls, written, notices };
}

describe("draftCommit", () => {
  it("drafts from the staged diff, shows it, copies it, and never commits", async () => {
    const { deps, model, requests, calls, written } = setup(
      "```\nfeat(parser): raise the limit to 20\n```",
      { staged: fixturePatch, unstaged: "diff --git a/other b/other" },
    );
    await draftCommit(deps);

    const sent = messageText(requests[0]?.messages[0] as Message);
    expect(sent).toContain(fixtureStat.trim());
    expect(sent).toContain("+const limit = 20;");
    expect(sent).not.toContain("a/other");
    expect(requests[0]?.tools).toEqual([]);
    expect(written).toEqual([copyToClipboard("feat(parser): raise the limit to 20")]);
    expect(model.entries.at(-2)).toEqual({
      kind: "info",
      text: "drafting a commit message from the staged diff",
    });
    expect(model.entries.at(-1)).toEqual({
      kind: "assistant",
      progress: true,
      text: "```\nfeat(parser): raise the limit to 20\n```\n\ncopied to your clipboard · keywork never commits, that part is yours",
    });
    expect(calls.every((args) => args[0] === "diff" && !args.includes("commit"))).toBe(true);
  });

  it("falls back to the unstaged diff", async () => {
    const { deps, model } = setup("fix: something", { unstaged: fixturePatch });
    await draftCommit(deps);
    expect(model.entries.at(-2)?.text).toBe("drafting a commit message from the unstaged diff");
  });

  it("says so when the tree is clean or no model is bound", async () => {
    const clean = setup("unused", {});
    await draftCommit(clean.deps);
    expect(clean.model.entries.at(-1)?.text).toBe(
      "nothing to draft · the working tree has no changes",
    );
    expect(clean.requests).toHaveLength(0);

    const notices: string[] = [];
    await draftCommit({
      ...clean.deps,
      conversation: () => undefined,
      notice: (text) => notices.push(text),
    });
    expect(notices).toEqual(["no model to draft with · focus a session with a model bound"]);
  });

  it("still shows the draft where the terminal takes no clipboard writes", async () => {
    const { deps, model, written } = setup("chore: tidy", { staged: fixturePatch }, false);
    await draftCommit(deps);
    expect(written).toEqual([]);
    expect(model.entries.at(-1)?.text).toContain("this terminal takes no clipboard writes");
  });

  it("reports a git failure in the transcript", async () => {
    const { deps, model } = setup("unused", {});
    await draftCommit({
      ...deps,
      git: async () => Promise.reject(new Error("not a git repository")),
    });
    expect(model.entries.at(-1)?.text).toBe(
      "couldn't draft a commit message · not a git repository",
    );
  });
});

describe("commitRequest", () => {
  it("caps the patch at the shared 30,000-char discipline and keeps the stat whole", () => {
    const patch = `diff --git a/big b/big\n${"+x\n".repeat(diffCharCap)}`;
    const request = commitRequest({ scope: "staged", stat: fixtureStat, patch });
    const sent = messageText(request.messages[0] as Message);
    expect(sent.startsWith(fixtureStat.trim())).toBe(true);
    expect(sent).toContain(`[diff cut at ${diffCharCap} of ${patch.length} chars`);
    expect(sent.length).toBeLessThan(diffCharCap + fixtureStat.length + 200);
  });
});

describe("workingDiff", () => {
  it("asks git for diffs only, with external drivers off", async () => {
    const { git, calls } = fakeGit({ unstaged: fixturePatch });
    expect((await workingDiff(git))?.scope).toBe("unstaged");
    for (const args of calls)
      expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });
});

describe("commitDraftCommand", () => {
  it("fits the command vocabulary", () => {
    const { deps } = setup("x", {});
    const command = commitDraftCommand(deps);
    expect(command.name).toBe("commit-draft");
    expect(command.aliases).toContain("draft-commit");
  });
});
