import { z } from "zod";

export const capKinds = [
  "files:read",
  "files:write",
  "exec",
  "screen:view",
  "screen:control",
  "clipboard",
] as const;

export type CapKind = (typeof capKinds)[number];

export type Cap =
  | { kind: "files:read"; paths: string[] }
  | { kind: "files:write"; paths: string[] }
  | { kind: "exec"; commands: string[] }
  | { kind: "screen:view" }
  | { kind: "screen:control" }
  | { kind: "clipboard" };

export const toolsOfCap: Readonly<Record<CapKind, readonly string[]>> = {
  "files:read": ["read"],
  "files:write": ["write", "edit"],
  exec: ["bash"],
  "screen:view": [],
  "screen:control": [],
  clipboard: [],
};

const pathGlob = z
  .string()
  .min(1)
  .max(512)
  .refine((glob) => !glob.includes("\0"), "a path glob cannot hold NUL");

const literalCommand = z
  .string()
  .max(256)
  .regex(
    /^[A-Za-z0-9_][\w.+:@/=-]*(?: [\w.+:@/=-]+)*$/,
    "an exec allowlist entry is a literal command head: words only, no globs, quotes or shell operators",
  );

export const capSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("files:read"), paths: z.array(pathGlob).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("files:write"), paths: z.array(pathGlob).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("exec"), commands: z.array(literalCommand).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("screen:view") }).strict(),
  z.object({ kind: z.literal("screen:control") }).strict(),
  z.object({ kind: z.literal("clipboard") }).strict(),
]);

export function capOfTool(caps: readonly Cap[], toolName: string): Cap | undefined {
  return caps.find((cap) => toolsOfCap[cap.kind].includes(toolName));
}

export function capLabel(cap: Cap): string {
  switch (cap.kind) {
    case "files:read":
    case "files:write":
      return `${cap.kind} ${cap.paths.join(" ")}`;
    case "exec":
      return `exec ${cap.commands.join(", ")}`;
    default:
      return cap.kind;
  }
}
