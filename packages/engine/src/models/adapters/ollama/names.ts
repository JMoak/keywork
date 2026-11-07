import { stringAt } from "../json.ts";

export function sameModel(entry: unknown, model: string): boolean {
  const names = [stringAt(entry, "name"), stringAt(entry, "model")];
  return names.some((name) => name !== undefined && withTag(name) === withTag(model));
}

function withTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}
