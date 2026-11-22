import { neutralizeRecalled } from "../memory/neutralize.ts";
import type { Setting, SettingWhat } from "./setting.ts";

export function quotedNameOf({ title, ref }: SettingWhat): string {
  return JSON.stringify(neutralizeRecalled(title ?? ref).slice(0, longestName));
}

export function calledOf({ id, what }: Pick<Setting, "id" | "what">): string {
  return `${quotedNameOf(what)} (${id})`;
}

export function saidOnOneLine(said: string, longest: number): string {
  return neutralizeRecalled(said).replace(/\s+/g, " ").trim().slice(0, longest);
}

const longestName = 80;
