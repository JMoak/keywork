import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcOpenQuestions,
  type ArcOpenQuestionsOptions,
  MissingOpenQuestionError,
  OpenQuestionCapError,
} from "./questions.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function questionsDir(options: Partial<ArcOpenQuestionsOptions> = {}): Promise<{
  questions: ArcOpenQuestions;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-questions-"));
  cleanups.push(dir);
  const questions = new ArcOpenQuestions({
    questionsDir: dir,
    trusted: true,
    now: () => new Date("2026-08-16T09:00:00.000Z"),
    cap: 2,
    ...options,
  });
  return { questions, dir };
}

describe("open questions", () => {
  it("writes a question note with the open-question frontmatter", async () => {
    const { questions, dir } = await questionsDir();
    await questions.add({
      title: "Which dock wins ties",
      body: "Left or last-focused?",
      provenance: "user",
    });
    const raw = await readFile(join(dir, "Which dock wins ties.md"), "utf8");
    expect(raw).toContain('type: "open-question"');
    expect(raw).toContain('status: "open"');
    expect(raw).toContain('provenance: "user"');
    expect(raw).toContain("Left or last-focused?");
  });

  it("redacts secrets before anything touches disk", async () => {
    const { questions, dir } = await questionsDir({ secrets: { API_KEY: "hunter2secret" } });
    await questions.add({
      title: "Key rotation",
      body: "Old key hunter2secret leaks?",
      provenance: "user",
    });
    const raw = await readFile(join(dir, "Key rotation.md"), "utf8");
    expect(raw).not.toContain("hunter2secret");
    expect(raw).toContain("‹redacted:API_KEY›");
  });

  it("stamps resolve and drop outcomes without deleting files", async () => {
    const { questions, dir } = await questionsDir();
    await questions.add({ title: "A", body: "a", provenance: "user" });
    await questions.add({ title: "B", body: "b", provenance: "agent" });
    await questions.resolve("A");
    await questions.drop("B");
    expect(await questions.open()).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(["A.md", "B.md"]);
    expect(await readFile(join(dir, "A.md"), "utf8")).toContain('status: "resolved"');
    expect(await readFile(join(dir, "B.md"), "utf8")).toContain('status: "dropped"');
  });

  it("refuses to act on questions that are not open", async () => {
    const { questions } = await questionsDir();
    await expect(questions.resolve("ghost")).rejects.toThrow(MissingOpenQuestionError);
  });
});

describe("the hard per-arc cap", () => {
  it("demands an explicit merge or drop once the cap is hit, writing nothing on refusal", async () => {
    const { questions, dir } = await questionsDir();
    await questions.add({ title: "A", body: "a", provenance: "user" });
    await questions.add({ title: "B", body: "b", provenance: "user" });
    await expect(questions.add({ title: "C", body: "c", provenance: "user" })).rejects.toThrow(
      OpenQuestionCapError,
    );
    expect((await readdir(dir)).sort()).toEqual(["A.md", "B.md"]);
  });

  it("names the open questions so the choice is informed", async () => {
    const { questions } = await questionsDir();
    await questions.add({ title: "A", body: "a", provenance: "user" });
    await questions.add({ title: "B", body: "b", provenance: "user" });
    const error = await questions
      .add({ title: "C", body: "c", provenance: "user" })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as OpenQuestionCapError);
    expect(error?.openTitles).toEqual(["A", "B"]);
    expect(error?.cap).toBe(2);
  });

  it("merge folds the newcomer into a survivor and records what was absorbed", async () => {
    const { questions, dir } = await questionsDir();
    await questions.add({ title: "A", body: "a", provenance: "user" });
    await questions.add({ title: "B", body: "b", provenance: "user" });
    await questions.add({ title: "C", body: "c body", provenance: "user" }, { merge: "A" });
    expect((await readdir(dir)).sort()).toEqual(["A.md", "B.md"]);
    const survivor = await readFile(join(dir, "A.md"), "utf8");
    expect(survivor).toContain("C: c body");
    expect(survivor).toContain('absorbed: ["C"]');
    expect((await questions.capEvents()).absorbed).toEqual([{ into: "A", titles: ["C"] }]);
  });

  it("drop retires a named question, keeps its file, and admits the newcomer", async () => {
    const { questions, dir } = await questionsDir();
    await questions.add({ title: "A", body: "a", provenance: "user" });
    await questions.add({ title: "B", body: "b", provenance: "user" });
    await questions.add({ title: "C", body: "c", provenance: "user" }, { drop: "B" });
    expect((await readdir(dir)).sort()).toEqual(["A.md", "B.md", "C.md"]);
    expect((await questions.open()).map((question) => question.title)).toEqual(["A", "C"]);
    expect((await questions.capEvents()).dropped).toEqual(["B"]);
  });
});
