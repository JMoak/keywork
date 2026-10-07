import { textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import {
  attachMentionedFiles,
  attachmentCharCap,
  hasAttachments,
  promptAsTyped,
} from "./mention-attachments.ts";

const disk: Record<string, string> = {
  "src/app.ts": "export const app = 1;\n",
  "src/big.ts": "x".repeat(attachmentCharCap + 50),
  "bin/blob": "a\u0000b",
};

function read(path: string): string | undefined {
  return disk[path];
}

describe("attachMentionedFiles", () => {
  it("appends each mentioned file once, after the typed prompt", () => {
    const sent = attachMentionedFiles("explain @src/app.ts and @src/app.ts again", read, []);
    expect(sent).toBe(
      'explain @src/app.ts and @src/app.ts again\n\n<attached path="src/app.ts">\nexport const app = 1;\n\n</attached>',
    );
  });

  it("leaves the prompt alone when nothing mentioned can be read", () => {
    expect(attachMentionedFiles("ping @someone about @nope.ts", read, [])).toBe(
      "ping @someone about @nope.ts",
    );
    expect(attachMentionedFiles("see @bin/blob", read, [])).toBe("see @bin/blob");
  });

  it("skips a file the conversation already carries unchanged", () => {
    const first = attachMentionedFiles("read @src/app.ts", read, []);
    const history = [textMessage("user", first)];
    expect(attachMentionedFiles("now fix @src/app.ts", read, history)).toBe("now fix @src/app.ts");
  });

  it("attaches again once the file has changed since", () => {
    const history = [textMessage("user", attachMentionedFiles("read @src/app.ts", read, []))];
    const changed = (path: string) => (path === "src/app.ts" ? "export const app = 2;" : undefined);
    expect(attachMentionedFiles("again @src/app.ts", changed, history)).toContain("app = 2");
  });

  it("refuses paths that leave the workspace", () => {
    const anything = () => "secret";
    for (const prompt of ["@../outside.txt", "@/etc/passwd", "@~/.ssh/id", "@src\\..\\..\\x"]) {
      expect(attachMentionedFiles(prompt, anything, [])).toBe(prompt);
    }
  });

  it("canonicalizes the path it reads and labels", () => {
    const seen: string[] = [];
    const recording = (path: string) => {
      seen.push(path);
      return "body";
    };
    expect(attachMentionedFiles("@./src/../src/app.ts", recording, [])).toContain(
      '<attached path="src/app.ts">',
    );
    expect(seen).toEqual(["src/app.ts"]);
  });

  it("cuts a long file at the shared char cap and says so", () => {
    const sent = attachMentionedFiles("@src/big.ts", read, []);
    expect(sent).toContain(`[cut at ${attachmentCharCap} of ${attachmentCharCap + 50} chars`);
    expect(sent.length).toBeLessThan(attachmentCharCap + 300);
  });

  it("never expands twice", () => {
    const once = attachMentionedFiles("@src/app.ts", read, []);
    expect(attachMentionedFiles(once, read, [])).toBe(once);
  });
});

describe("promptAsTyped", () => {
  it("gives back what the user typed", () => {
    const sent = attachMentionedFiles("explain @src/app.ts", read, []);
    expect(hasAttachments(sent)).toBe(true);
    expect(promptAsTyped(sent)).toBe("explain @src/app.ts");
    expect(promptAsTyped("plain prompt")).toBe("plain prompt");
  });
});
