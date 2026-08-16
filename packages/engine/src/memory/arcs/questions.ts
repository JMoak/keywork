import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Frontmatter, parseDocument, serializeDocument } from "../frontmatter.ts";
import { validateConceptTitle } from "../naming.ts";
import { type NamedSecret, redactForPersistence } from "../redaction.ts";
import { MemoryInertError } from "../store.ts";

export type OpenQuestionStatus = "open" | "resolved" | "dropped" | "carried";

export interface OpenQuestion {
  title: string;
  status: OpenQuestionStatus;
  provenance: "user" | "agent";
  created: string;
  body: string;
  absorbed: string[];
  closedAt?: string;
  carriedTo?: string;
}

export interface OpenQuestionInput {
  title: string;
  body: string;
  provenance: "user" | "agent";
}

export type CapOverflowChoice = { merge: string } | { drop: string };

export interface CapEvents {
  dropped: string[];
  absorbed: { into: string; titles: string[] }[];
}

export interface ArcOpenQuestionsOptions {
  questionsDir: string;
  trusted: boolean;
  now?: () => Date;
  secrets?: Record<string, string>;
  cap?: number;
}

export const defaultOpenQuestionCap = 7;

export class OpenQuestionCapError extends Error {
  constructor(
    readonly cap: number,
    readonly openTitles: string[],
  ) {
    super(
      `the arc already holds ${cap} open questions; merge into or drop one of: ${openTitles.join(", ")}`,
    );
    this.name = "OpenQuestionCapError";
  }
}

export class MissingOpenQuestionError extends Error {
  constructor(readonly title: string) {
    super(`no open question titled "${title}"`);
    this.name = "MissingOpenQuestionError";
  }
}

export class ArcOpenQuestions {
  readonly cap: number;
  private readonly dir: string;
  private readonly trusted: boolean;
  private readonly now: () => Date;
  private readonly secrets: NamedSecret[];

  constructor(options: ArcOpenQuestionsOptions) {
    this.dir = options.questionsDir;
    this.trusted = options.trusted;
    this.now = options.now ?? (() => new Date());
    this.secrets = Object.entries(options.secrets ?? {}).map(([name, value]) => ({ name, value }));
    this.cap = options.cap ?? defaultOpenQuestionCap;
  }

  async list(): Promise<OpenQuestion[]> {
    if (!this.trusted) return [];
    const questions: OpenQuestion[] = [];
    for (const file of await this.listFiles()) {
      const raw = await readFile(join(this.dir, file), "utf8");
      questions.push(parseQuestion(file, parseDocument(raw, file)));
    }
    return questions.sort((a, b) => a.created.localeCompare(b.created));
  }

  async open(): Promise<OpenQuestion[]> {
    return (await this.list()).filter((question) => question.status === "open");
  }

  async capEvents(): Promise<CapEvents> {
    const questions = await this.list();
    return {
      dropped: questions.filter((question) => question.status === "dropped").map((q) => q.title),
      absorbed: questions
        .filter((question) => question.absorbed.length > 0)
        .map((question) => ({ into: question.title, titles: question.absorbed })),
    };
  }

  async add(input: OpenQuestionInput, overflow?: CapOverflowChoice): Promise<OpenQuestion> {
    this.gate();
    const title = redactForPersistence(input.title, this.secrets);
    validateConceptTitle(title);
    const body = redactForPersistence(input.body, this.secrets);
    const open = await this.open();
    if (open.length < this.cap) return this.write(title, body, input.provenance);
    if (overflow === undefined)
      throw new OpenQuestionCapError(
        this.cap,
        open.map((question) => question.title),
      );
    if ("merge" in overflow) return this.mergeInto(overflow.merge, title, body);
    await this.drop(overflow.drop);
    return this.write(title, body, input.provenance);
  }

  async resolve(title: string): Promise<OpenQuestion> {
    return this.close(title, "resolved");
  }

  async drop(title: string): Promise<OpenQuestion> {
    return this.close(title, "dropped");
  }

  async markCarried(title: string, successor: string): Promise<OpenQuestion> {
    return this.close(title, "carried", successor);
  }

  private async close(
    title: string,
    status: Exclude<OpenQuestionStatus, "open">,
    carriedTo?: string,
  ): Promise<OpenQuestion> {
    this.gate();
    const question = await this.requireOpen(title);
    const updated: OpenQuestion = {
      ...question,
      status,
      closedAt: this.now().toISOString(),
      ...(carriedTo !== undefined && { carriedTo }),
    };
    await this.persist(updated);
    return updated;
  }

  private async mergeInto(target: string, title: string, body: string): Promise<OpenQuestion> {
    const survivor = await this.requireOpen(target);
    const merged: OpenQuestion = {
      ...survivor,
      body: `${survivor.body.replace(/\n+$/, "")}\n\n${title}: ${body.trim()}\n`,
      absorbed: [...survivor.absorbed, title],
    };
    await this.persist(merged);
    return merged;
  }

  private async requireOpen(title: string): Promise<OpenQuestion> {
    const question = (await this.open()).find((candidate) => candidate.title === title);
    if (question === undefined) throw new MissingOpenQuestionError(title);
    return question;
  }

  private async write(
    title: string,
    body: string,
    provenance: "user" | "agent",
  ): Promise<OpenQuestion> {
    const question: OpenQuestion = {
      title,
      status: "open",
      provenance,
      created: this.now().toISOString(),
      body: body.endsWith("\n") ? body : `${body}\n`,
      absorbed: [],
    };
    await this.persist(question);
    return question;
  }

  private async persist(question: OpenQuestion): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const document = serializeDocument(questionFrontmatter(question), question.body);
    await writeFile(join(this.dir, `${question.title}.md`), document, "utf8");
  }

  private gate(): void {
    if (!this.trusted) throw new MemoryInertError();
  }

  private async listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((file) => file.endsWith(".md"));
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }
}

function questionFrontmatter(question: OpenQuestion): Frontmatter {
  return {
    type: "open-question",
    status: question.status,
    provenance: question.provenance,
    created: question.created,
    ...(question.absorbed.length > 0 && { absorbed: question.absorbed }),
    ...(question.closedAt !== undefined && { closed: question.closedAt }),
    ...(question.carriedTo !== undefined && { carried_to: question.carriedTo }),
  };
}

function parseQuestion(
  file: string,
  document: { frontmatter: Frontmatter; body: string },
): OpenQuestion {
  const { frontmatter, body } = document;
  const closedAt = typeof frontmatter.closed === "string" ? frontmatter.closed : undefined;
  const carriedTo = typeof frontmatter.carried_to === "string" ? frontmatter.carried_to : undefined;
  return {
    title: file.slice(0, -".md".length),
    status: parseStatus(frontmatter.status),
    provenance: frontmatter.provenance === "agent" ? "agent" : "user",
    created: typeof frontmatter.created === "string" ? frontmatter.created : "",
    body,
    absorbed: Array.isArray(frontmatter.absorbed) ? frontmatter.absorbed : [],
    ...(closedAt !== undefined && { closedAt }),
    ...(carriedTo !== undefined && { carriedTo }),
  };
}

function parseStatus(value: unknown): OpenQuestionStatus {
  return value === "resolved" || value === "dropped" || value === "carried" ? value : "open";
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code: unknown }).code === "ENOENT" ||
      (error as { code: unknown }).code === "ENOTDIR")
  );
}
