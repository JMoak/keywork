import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionEffect, PermissionRule } from "../config/schema.ts";
import { commandWords } from "./command-words.ts";

export const trustedReadRules: readonly PermissionRule[] = Object.freeze([
  ...bashRules("allow", [
    "git status*",
    "git log*",
    "git diff*",
    "git show*",
    "git rev-parse*",
    "git remote -v",
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch --all",
    "git branch --remotes",
    "git branch --show-current",
    "git branch --list *",
    "git branch --contains *",
    "git branch --merged *",
    "git branch --no-merged *",
    "ls*",
    "dir*",
    "cat *",
    "head *",
    "tail *",
    "wc *",
    "pwd",
    "which *",
    "where *",
    "rg *",
    "grep *",
    "find *",
    "tree*",
    "stat *",
    "file *",
    "echo *",
    "type *",
    "node --version",
    "bun --version",
    "npm --version",
    "git --version",
    "python --version",
  ]),
  ...bashRules("ask", [
    "find *-delete*",
    "find *-exec*",
    "find *-ok*",
    "find *-fprint*",
    "find *-fls*",
    "rg *--pre*",
    "git log*--output*",
    "git diff*--output*",
    "git show*--output*",
    "tree*-o*",
    "file *-C*",
  ]),
]);

export function trustedReadStaysWithin(
  commandPart: string,
  readable: (path: string) => boolean,
): boolean {
  const [, ...operands] = commandWords(commandPart);
  return operands.every((word) => operandStaysWithin(withoutQuotes(word), readable));
}

function bashRules(effect: PermissionEffect, resources: readonly string[]): PermissionRule[] {
  return resources.map((resource) => ({ action: "bash", resource, effect }));
}

function operandStaysWithin(word: string, readable: (path: string) => boolean): boolean {
  if (!word.startsWith("-")) return pathStaysWithin(word, readable);
  const assignment = word.indexOf("=");
  if (assignment !== -1) return pathStaysWithin(word.slice(assignment + 1), readable);
  return !attachedPathCharacters.test(word);
}

function pathStaysWithin(word: string, readable: (path: string) => boolean): boolean {
  if (word === "") return true;
  if (expandsBeyondItsText(word) || namesShellProvider(word)) return false;
  return shellReadingsOf(word).every((path) => readable(path));
}

function expandsBeyondItsText(word: string): boolean {
  if (/[{}]/.test(word)) return true;
  if (word.startsWith("~") && !/^~(?:[\\/]|$)/.test(word)) return true;
  return word.split(/[\\/]/).some((segment) => /^[.[].*[*?[]/.test(segment));
}

function namesShellProvider(word: string): boolean {
  return word.includes("::") || shellProviderDrive.test(word);
}

function shellReadingsOf(word: string): string[] {
  const unescaped = word.replaceAll(/\\(.)/g, "$1");
  return [...new Set([word, unescaped])].map(homeExpanded);
}

function homeExpanded(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function withoutQuotes(word: string): string {
  return word.replaceAll(/["']/g, "");
}

const attachedPathCharacters = /[\\/~:]/;
const shellProviderDrive = /^(?:alias|cert|env|function|hkcu|hklm|temp|variable|wsman):/i;
