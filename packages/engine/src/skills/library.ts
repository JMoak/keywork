import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { countOccurrences, toUnixEol } from "@keywork/shared";
import { type LayerSource, validatedName } from "../extensions/layers.ts";
import type { SkillDefinition } from "../extensions/skills.ts";
import { type FileDelta, fileDelta } from "../memory/ledger.ts";
import {
  type AgentAuthoredSkill,
  claimAgentAuthored,
  createAgentAuthored,
  keyworkAuthor,
  reviseAgentAuthored,
} from "./authorship.ts";
import type { SkillTelemetry } from "./telemetry.ts";

export interface SkillGenesis {
  root: string;
  source: LayerSource;
  convention: string;
  author?: string | undefined;
}

export type SkillChangeKind = "patch" | "rewrite" | "create";

export interface SkillChange {
  kind: SkillChangeKind;
  skill: SkillDefinition;
  delta: FileDelta;
}

export interface SkillView {
  skill: SkillDefinition;
  files: string[];
}

export interface SkillLibraryOptions {
  skills: readonly SkillDefinition[];
  genesis?: SkillGenesis | undefined;
  telemetry?: SkillTelemetry | undefined;
  onChange?: ((change: SkillChange) => void) | undefined;
}

export class UnknownSkillError extends Error {
  constructor(name: string, available: readonly string[]) {
    super(`unknown skill "${name}"; available: ${available.join(", ") || "(none)"}`);
    this.name = "UnknownSkillError";
  }
}

export class SkillPatchError extends Error {
  constructor(skillName: string, detail: string) {
    super(`cannot patch skill "${skillName}": ${detail}`);
    this.name = "SkillPatchError";
  }
}

export class ReferenceOutsideSkillError extends Error {
  constructor(skillName: string, path: string) {
    super(
      `"${path}" is not inside skill "${skillName}"; reference paths stay within the skill's directory`,
    );
    this.name = "ReferenceOutsideSkillError";
  }
}

export class SkillGenesisUnavailableError extends Error {
  constructor() {
    super("no place to create skills: this workspace has no trusted project root");
    this.name = "SkillGenesisUnavailableError";
  }
}

export class SkillLibrary {
  private readonly byName: Map<string, SkillDefinition>;
  private readonly genesis: SkillGenesis | undefined;
  private readonly telemetry: SkillTelemetry | undefined;
  private readonly onChange: ((change: SkillChange) => void) | undefined;

  constructor(options: SkillLibraryOptions) {
    this.byName = new Map(options.skills.map((skill) => [skill.name, skill]));
    this.genesis = options.genesis;
    this.telemetry = options.telemetry;
    this.onChange = options.onChange;
  }

  skills(): SkillDefinition[] {
    return [...this.byName.values()];
  }

  canCreate(): boolean {
    return this.genesis !== undefined;
  }

  find(name: string): SkillDefinition {
    const skill = this.byName.get(name);
    if (skill === undefined) throw new UnknownSkillError(name, [...this.byName.keys()]);
    return skill;
  }

  async use(name: string): Promise<SkillDefinition> {
    const skill = this.find(name);
    await this.telemetry?.record(name, "use");
    return skill;
  }

  async view(name: string): Promise<SkillView> {
    const skill = this.find(name);
    await this.telemetry?.record(name, "view");
    return { skill, files: await referenceFilesUnder(skill.dir) };
  }

  async reference(name: string, path: string): Promise<string> {
    const skill = this.find(name);
    const content = await readFile(referencePath(skill, path), "utf8");
    await this.telemetry?.record(name, "reference");
    return content;
  }

  async patch(name: string, oldText: string, newText: string): Promise<SkillDefinition> {
    const previous = this.find(name);
    const claimed = await claimAgentAuthored(previous.file);
    const body = patchedBody(name, claimed.body, oldText, newText);
    return this.revise("patch", previous, claimed, { ...claimed.frontmatter }, body);
  }

  async rewrite(name: string, body: string, description?: string): Promise<SkillDefinition> {
    const previous = this.find(name);
    const claimed = await claimAgentAuthored(previous.file);
    const frontmatter =
      description === undefined
        ? { ...claimed.frontmatter }
        : { ...claimed.frontmatter, description };
    return this.revise("rewrite", previous, claimed, frontmatter, body);
  }

  async create(name: string, description: string, body: string): Promise<SkillDefinition> {
    if (this.genesis === undefined) throw new SkillGenesisUnavailableError();
    const skillName = validatedName(name);
    if (this.byName.has(skillName)) {
      throw new Error(`skill "${skillName}" already exists; patch it instead of creating another`);
    }
    const dir = join(this.genesis.root, this.genesis.convention, skillName);
    const file = join(dir, "SKILL.md");
    await mkdir(dir, { recursive: true });
    const author = this.genesis.author ?? keyworkAuthor;
    const content = await createAgentAuthored(file, author, {
      frontmatter: { name: skillName, description },
      body,
    });
    const skill: SkillDefinition = {
      name: skillName,
      description,
      body: body.trim(),
      dir,
      file,
      source: this.genesis.source,
      convention: this.genesis.convention,
      authoredBy: author,
    };
    this.byName.set(skillName, skill);
    await this.telemetry?.record(skillName, "create");
    this.onChange?.({ kind: "create", skill, delta: fileDelta(file, null, content) });
    return skill;
  }

  private async revise(
    kind: "patch" | "rewrite",
    previous: SkillDefinition,
    claimed: AgentAuthoredSkill,
    frontmatter: AgentAuthoredSkill["frontmatter"],
    body: string,
  ): Promise<SkillDefinition> {
    const content = await reviseAgentAuthored(claimed, { frontmatter, body });
    const description = frontmatter.description;
    const skill: SkillDefinition = {
      ...previous,
      body: body.trim(),
      description: typeof description === "string" ? description : previous.description,
      authoredBy: claimed.author,
    };
    this.byName.set(skill.name, skill);
    await this.telemetry?.record(skill.name, kind);
    this.onChange?.({ kind, skill, delta: fileDelta(claimed.file, claimed.raw, content) });
    return skill;
  }
}

const maxReferenceDepth = 3;

function patchedBody(skillName: string, body: string, oldText: string, newText: string): string {
  const content = toUnixEol(body);
  const search = toUnixEol(oldText);
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) {
    throw new SkillPatchError(
      skillName,
      "oldText not found; view the skill and match it exactly, or rewrite it",
    );
  }
  if (occurrences > 1) {
    throw new SkillPatchError(
      skillName,
      `oldText matches ${occurrences} places; add surrounding context`,
    );
  }
  return content.replace(search, toUnixEol(newText));
}

function referencePath(skill: SkillDefinition, path: string): string {
  const target = resolve(skill.dir, path);
  const inside = relative(skill.dir, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new ReferenceOutsideSkillError(skill.name, path);
  }
  return target;
}

async function referenceFilesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(dir, dir, 0, files);
  return files.sort();
}

async function collectFiles(
  root: string,
  dir: string,
  depth: number,
  files: string[],
): Promise<void> {
  if (depth > maxReferenceDepth) return;
  for (const entry of await readdirOrEmpty(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, depth + 1, files);
    else if (entry.isFile() && !(depth === 0 && entry.name === "SKILL.md")) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
