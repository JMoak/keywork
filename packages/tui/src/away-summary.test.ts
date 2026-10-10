import { EventBus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { AwayWatch, awayDigest } from "./away-summary.ts";
import type { TranscriptEntry } from "./transcript-feed.ts";

function watched(): { watch: AwayWatch; bus: EventBus } {
  const watch = new AwayWatch();
  const bus = new EventBus();
  watch.follow(bus);
  return { watch, bus };
}

describe("AwayWatch", () => {
  it("opens a stretch when presence goes and closes it when it returns", () => {
    const { watch } = watched();
    expect(watch.attend({ pane: true }, 0)).toBeUndefined();
    expect(watch.attend({ pane: false }, 3)).toBeUndefined();
    watch.turnSettled();
    expect(watch.attend({ pane: true }, 9)).toEqual({ from: 3, files: new Set(), settled: true });
  });

  it("has nothing to say when no turn settled meanwhile", () => {
    const { watch } = watched();
    watch.attend({ pane: false }, 0);
    expect(watch.attend({ pane: true }, 0)).toBeUndefined();
  });

  it("needs both the pane and the terminal to count you present", () => {
    const { watch } = watched();
    watch.attend({ pane: true }, 0);
    watch.attend({ terminal: false }, 1);
    watch.turnSettled();
    expect(watch.attend({ pane: true }, 2)).toBeUndefined();
    expect(watch.attend({ terminal: true }, 2)?.from).toBe(1);
  });

  it("records files written and files a command changed, only while you are away", () => {
    const { watch, bus } = watched();
    const edit = (callId: string, path: string) => {
      bus.emit("tool.started", {
        call: { type: "tool-call", callId, name: "edit", arguments: { path } },
      });
      bus.emit("tool.finished", { callId, output: "ok", isError: false });
    };
    edit("before", "seen.ts");
    watch.attend({ pane: false }, 0);
    edit("after", "src/a.ts");
    bus.emit("tool.started", {
      call: {
        type: "tool-call",
        callId: "bad",
        name: "write",
        arguments: { path: "src/failed.ts" },
      },
    });
    bus.emit("tool.finished", { callId: "bad", output: "denied", isError: true });
    bus.emit("tool.finished", {
      callId: "sh",
      output: "done\n\nchanged 2 files on disk:\n  src/b.ts +3 -1\n  docs/c.md +1 -0\n\ndiff --git",
      isError: false,
    });
    watch.turnSettled();
    expect([...(watch.attend({ pane: true }, 0)?.files ?? [])]).toEqual([
      "src/a.ts",
      "src/b.ts",
      "docs/c.md",
    ]);
  });
});

describe("awayDigest", () => {
  const stretch = (files: string[]) => ({ from: 1, files: new Set(files), settled: true });

  it("says what changed, how the reply ended and what waits on you", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", text: "before you left" },
      { kind: "assistant", text: "## Done\n\n- **Tests** pass now\n\n```\ncode\n```" },
    ];
    expect(awayDigest(stretch(["a.ts", "b.ts"]), entries, 'edit {"path":"c.ts"}')).toBe(
      'while you were away: changed a.ts, b.ts; it ended on "Tests pass now"; waiting on you: edit {"path":"c.ts"}',
    );
  });

  it("names a failure and folds a long file list", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "go" },
      { kind: "error", text: "rate limited" },
    ];
    expect(awayDigest(stretch(["1", "2", "3", "4", "5", "6"]), entries, undefined)).toBe(
      'while you were away: changed 1, 2, 3, 4 and 2 more; it stopped on "rate limited"',
    );
  });

  it("stays quiet with nothing to report", () => {
    expect(awayDigest(stretch([]), [{ kind: "info", text: "x" }], undefined)).toBeUndefined();
  });
});
