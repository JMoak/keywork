import { fileURLToPath, pathToFileURL } from "node:url";
import { segments } from "../../packages/tui/src/width.ts";
import { FrameAttributes } from "./frame.ts";
import type { FrameSize } from "./scenario.ts";

export interface LinkCell {
  readonly text: string;
  readonly target: "expected" | "other" | "none";
}

export interface LinkReplay {
  readonly rows: readonly (readonly LinkCell[])[];
  readonly activeTarget: string;
}

type ReplayCore = Pick<typeof import("@opentui/core/zig"), "resolveRenderLib"> &
  Pick<typeof import("@opentui/core/buffer"), "OptimizedBuffer">;

const esc = "\x1b";
const bell = "\x07";
const linkOrRendition = new RegExp(
  String.raw`${esc}\]8;[^;${bell}${esc}]*;([^${bell}${esc}]*)(?:${bell}|${esc}\\)|${esc}\[[0-?]*[ -/]*m`,
  "g",
);

// The embedded terminal exposes SGR attributes per cell. Reserve two of them for OSC 8 targets.
export function markLinkTargets(bytes: string, expectedTarget: string) {
  let activeTarget = "";
  const marked = bytes.replace(linkOrRendition, (_, target: string | undefined) => {
    if (target === undefined) return "";
    activeTarget = target;
    if (target === "") return "\x1b[0m";
    return target === expectedTarget ? "\x1b[0;1m" : "\x1b[0;3m";
  });
  return { marked, activeTarget };
}

export async function replayLinks(
  bytes: string,
  size: FrameSize,
  expectedTarget: string,
): Promise<LinkReplay> {
  const anchor = fileURLToPath(new URL("../../packages/tui/src/", import.meta.url));
  const resolved = Bun.resolveSync("@opentui/core", anchor);
  const { OptimizedBuffer, resolveRenderLib } = (await import(
    pathToFileURL(resolved).href
  )) as ReplayCore;
  const lib = resolveRenderLib();
  const { marked, activeTarget } = markLinkTargets(bytes, expectedTarget);
  const buffer = OptimizedBuffer.create(size.width, size.height, "unicode");
  try {
    const terminal = lib.createEmbeddedTerminal({ cols: size.width, rows: size.height });
    try {
      lib.embeddedTerminalWrite(terminal, marked);
      lib.embeddedTerminalCompose(terminal, buffer.ptr, 0, 0);
      const rows = buffer.getSpanLines().map(({ spans }) =>
        spans.flatMap(({ text, attributes }) => {
          const target = targetOf(attributes);
          return segments(text).flatMap(({ text, width }) => [
            { text, target },
            ...Array.from({ length: Math.max(0, width - 1) }, () => ({ text: "", target })),
          ]);
        }),
      );
      return { rows, activeTarget };
    } finally {
      lib.destroyEmbeddedTerminal(terminal);
    }
  } finally {
    buffer.destroy();
  }
}

function targetOf(attributes: number): LinkCell["target"] {
  if (attributes & FrameAttributes.ITALIC) return "other";
  return attributes & FrameAttributes.BOLD ? "expected" : "none";
}
