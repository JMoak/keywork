import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isMissingFileError,
  type MemoryQuestion,
  memoryEvalProofs,
  memoryQuestions,
  type QuestionProof,
} from "../../packages/engine/src/index.ts";
import { repoRoot } from "../lib/repo-files.ts";
import { verdictHeading } from "./report.ts";

export const reportsDir = "docs/memory-eval";

export function reportFile(edition: string): string {
  return `${reportsDir}/${edition}.md`;
}

export function provenInReport(markdown: string): MemoryQuestion[] {
  const verdict = markdown.split(verdictHeading)[1]?.split("\n## ")[0] ?? "";
  return verdict.split("\n").flatMap((line) => {
    const [, question, proven] = verdictRowPattern.exec(line) ?? [];
    return proven === "yes" && isQuestion(question) ? [question] : [];
  });
}

export async function proofFindings(
  proofs: readonly QuestionProof[] = memoryEvalProofs,
  root = repoRoot,
): Promise<string[]> {
  const reports = await readReports(join(root, reportsDir));
  const claimed = proofs.flatMap((proof) => unbackedProof(proof, reports));
  const unlisted = [...reports].flatMap(([edition, markdown]) =>
    provenInReport(markdown)
      .filter((question) => !proofs.some((proof) => isProofOf(proof, edition, question)))
      .map(
        (question) =>
          `${reportFile(edition)} proves \`${question}\`; add { edition: "${edition}", question: "${question}" } to memoryEvalProofs`,
      ),
  );
  return [...claimed, ...unlisted];
}

const verdictRowPattern = /^\| `([^`]+)` \| [^|]* \| [^|]* \| (yes|no|reference) \|$/;

function unbackedProof(proof: QuestionProof, reports: ReadonlyMap<string, string>): string[] {
  const markdown = reports.get(proof.edition);
  if (markdown === undefined)
    return [
      `memoryEvalProofs proves \`${proof.question}\` for ${proof.edition}, but ${reportFile(proof.edition)} is not checked in`,
    ];
  if (!provenInReport(markdown).includes(proof.question))
    return [
      `memoryEvalProofs proves \`${proof.question}\` for ${proof.edition}, but ${reportFile(proof.edition)} does not`,
    ];
  return [];
}

function isProofOf(proof: QuestionProof, edition: string, question: MemoryQuestion): boolean {
  return proof.edition === edition && proof.question === question;
}

async function readReports(dir: string): Promise<Map<string, string>> {
  const reports = new Map<string, string>();
  for (const name of await reportNames(dir)) {
    reports.set(name.slice(0, -".md".length), await readFile(join(dir, name), "utf8"));
  }
  return reports;
}

async function reportNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md") && name !== "README.md");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

const catalog: ReadonlySet<string> = new Set(Object.values(memoryQuestions));

function isQuestion(value: string | undefined): value is MemoryQuestion {
  return value !== undefined && catalog.has(value);
}
