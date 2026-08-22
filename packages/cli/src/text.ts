export function excerpt(text: string, limit: number): string {
  return clip(text.replaceAll("\n", " "), limit);
}

export function firstLine(text: string, limit: number): string {
  return clip(text.split("\n", 1)[0] ?? "", limit);
}

export function compactJson(value: unknown, limit: number): string {
  return clip(JSON.stringify(value) ?? "", limit);
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
