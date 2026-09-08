import { readFile, writeFile } from "node:fs/promises";
import { type Frontmatter, parseDocument, serializeDocument } from "../memory/frontmatter.ts";
import { writeFileAtomic } from "../memory/vault-files.ts";

export const authoredByKey = "authored_by";
export const keyworkAuthor = "keywork";

export interface AgentAuthoredSkill {
  readonly file: string;
  readonly author: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
  readonly raw: string;
}

export interface SkillRevision {
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

export class ProtectedSkillError extends Error {
  constructor(readonly file: string) {
    super(
      `${file} is protected: only skills whose frontmatter carries "${authoredByKey}" may be changed by the agent; a person owns this one`,
    );
    this.name = "ProtectedSkillError";
  }
}

export class SkillAlreadyExistsError extends Error {
  constructor(readonly file: string) {
    super(`${file} already exists; skills are created once and then patched`);
    this.name = "SkillAlreadyExistsError";
  }
}

export function authorOf(frontmatter: Frontmatter): string | undefined {
  const value = frontmatter[authoredByKey];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export async function claimAgentAuthored(file: string): Promise<AgentAuthoredSkill> {
  const raw = await readFile(file, "utf8");
  const { frontmatter, body } = parseDocument(raw, file);
  const author = authorOf(frontmatter);
  if (author === undefined) throw new ProtectedSkillError(file);
  return { file, author, frontmatter, body, raw };
}

export async function reviseAgentAuthored(
  claimed: AgentAuthoredSkill,
  revision: SkillRevision,
): Promise<string> {
  const content = agentAuthoredDocument(claimed.author, revision);
  await writeFileAtomic(claimed.file, content);
  return content;
}

export async function createAgentAuthored(
  file: string,
  author: string,
  revision: SkillRevision,
): Promise<string> {
  const content = agentAuthoredDocument(author, revision);
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isExistingFileError(error)) throw new SkillAlreadyExistsError(file);
    throw error;
  }
  return content;
}

function agentAuthoredDocument(author: string, revision: SkillRevision): string {
  return serializeDocument(
    { ...revision.frontmatter, [authoredByKey]: author },
    withTrailingNewline(revision.body),
  );
}

function withTrailingNewline(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

function isExistingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
