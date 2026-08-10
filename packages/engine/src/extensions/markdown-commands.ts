import { readFile } from "node:fs/promises";
import { confinedPath } from "../tools/confine.ts";
import {
  definitionString,
  type ExtensionLoadFailure,
  type LayeredDirs,
  type LayerSource,
  loadLayeredMarkdown,
  type MarkdownDefinition,
} from "./layers.ts";

export interface CommandDefinition {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  template: string;
  file: string;
  source: LayerSource;
}

export interface CommandLoad {
  commands: CommandDefinition[];
  failures: ExtensionLoadFailure[];
}

export interface CommandRuntime {
  runShell(command: string): Promise<string>;
  embedFile(path: string): Promise<string | undefined>;
}

export async function loadCommands(dirs: LayeredDirs): Promise<CommandLoad> {
  const { items, failures } = await loadLayeredMarkdown(dirs, buildCommand);
  return { commands: items, failures };
}

export async function renderCommand(
  template: string,
  args: string,
  runtime: CommandRuntime,
): Promise<string> {
  const segments = scanTemplate(template);
  const rendered: string[] = [];
  for (const segment of segments) {
    rendered.push(await renderSegment(segment, args, runtime));
  }
  const prompt = rendered.join("");
  if (args !== "" && !segments.some((segment) => segment.kind === "arguments")) {
    return `${prompt}\n\n${args}`;
  }
  return prompt;
}

export function fileEmbedder(root: string): (path: string) => Promise<string | undefined> {
  return async (path) => {
    const confined = confinedPath(root, path);
    try {
      return await readFile(confined, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  };
}

export type TemplateSegment =
  | { kind: "literal"; text: string }
  | { kind: "arguments" }
  | { kind: "shell"; command: string }
  | { kind: "file"; path: string; raw: string };

export function scanTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let literal = "";
  let index = 0;
  const flush = () => {
    if (literal !== "") segments.push({ kind: "literal", text: literal });
    literal = "";
  };
  while (index < template.length) {
    const token = tokenAt(template, index);
    if (token === undefined) {
      literal += template[index];
      index += 1;
      continue;
    }
    flush();
    segments.push(token.segment);
    index += token.length;
  }
  flush();
  return segments;
}

const argumentsToken = "$ARGUMENTS";
const filePathChars = /^[\w./\\~-]+/;

function tokenAt(
  template: string,
  index: number,
): { segment: TemplateSegment; length: number } | undefined {
  return argumentsAt(template, index) ?? shellAt(template, index) ?? fileMentionAt(template, index);
}

function argumentsAt(
  template: string,
  index: number,
): { segment: TemplateSegment; length: number } | undefined {
  if (!template.startsWith(argumentsToken, index)) return undefined;
  return { segment: { kind: "arguments" }, length: argumentsToken.length };
}

function shellAt(
  template: string,
  index: number,
): { segment: TemplateSegment; length: number } | undefined {
  if (template[index] !== "!" || template[index + 1] !== "`") return undefined;
  const closing = template.indexOf("`", index + 2);
  if (closing === -1) return undefined;
  const command = template.slice(index + 2, closing);
  return { segment: { kind: "shell", command }, length: closing + 1 - index };
}

function fileMentionAt(
  template: string,
  index: number,
): { segment: TemplateSegment; length: number } | undefined {
  if (template[index] !== "@" || !startsMention(template, index)) return undefined;
  const match = filePathChars.exec(template.slice(index + 1));
  if (match === null) return undefined;
  const path = match[0].replace(/[.,;:]+$/, "");
  if (path === "") return undefined;
  const raw = `@${path}`;
  return { segment: { kind: "file", path, raw }, length: raw.length };
}

function startsMention(template: string, index: number): boolean {
  if (index === 0) return true;
  const before = template[index - 1] ?? "";
  return /[\s("'[{<=:,]/.test(before);
}

async function renderSegment(
  segment: TemplateSegment,
  args: string,
  runtime: CommandRuntime,
): Promise<string> {
  switch (segment.kind) {
    case "literal":
      return segment.text;
    case "arguments":
      return args;
    case "shell":
      return runtime.runShell(segment.command);
    case "file":
      return (await runtime.embedFile(segment.path)) ?? segment.raw;
  }
}

function buildCommand(definition: MarkdownDefinition): CommandDefinition {
  const description = definitionString(definition.frontmatter, "description");
  const agent = definitionString(definition.frontmatter, "agent");
  const model = definitionString(definition.frontmatter, "model");
  return {
    name: definition.name,
    ...(description !== undefined && { description }),
    ...(agent !== undefined && { agent }),
    ...(model !== undefined && { model }),
    template: definition.body.trim(),
    file: definition.file,
    source: definition.source,
  };
}
