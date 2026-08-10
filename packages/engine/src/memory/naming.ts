export class InvalidTitleError extends Error {
  constructor(
    readonly title: string,
    detail: string,
  ) {
    super(`invalid note title "${title}": ${detail}`);
    this.name = "InvalidTitleError";
  }
}

export function validateConceptTitle(title: string): void {
  if (title.trim() === "") throw new InvalidTitleError(title, "empty");
  if (title !== title.trim()) throw new InvalidTitleError(title, "surrounding whitespace");
  if (forbiddenTitleChars.test(title)) throw new InvalidTitleError(title, "forbidden character");
  if (title.startsWith(".")) throw new InvalidTitleError(title, "leading dot");
  if (title.endsWith(".")) throw new InvalidTitleError(title, "trailing dot");
  if (reservedWindowsNames.test(title)) throw new InvalidTitleError(title, "reserved device name");
  if (reservedVaultNames.has(title.toLowerCase()))
    throw new InvalidTitleError(title, "reserved by the vault layout");
}

export function canonicalEntityPath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  if (normalized === "") throw new InvalidTitleError(path, "empty entity path");
  if (/^[A-Za-z]:/.test(normalized)) throw new InvalidTitleError(path, "absolute path");
  for (const segment of normalized.split("/")) validateEntitySegment(segment, path);
  return normalized;
}

export function titleKey(name: string): string {
  return name.toLowerCase();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is forbidden
const forbiddenTitleChars = /[<>:"/\\|?*[\]#^]|[\x00-\x1f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is forbidden
const forbiddenSegmentChars = /[<>:"|?*[\]#^\\]|[\x00-\x1f]/;
const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const reservedVaultNames = new Set(["memory", "curation", "daily", "entities"]);

function validateEntitySegment(segment: string, path: string): void {
  if (segment === "" || segment === "." || segment === "..")
    throw new InvalidTitleError(path, `unsafe path segment "${segment}"`);
  if (segment !== segment.trim()) throw new InvalidTitleError(path, "surrounding whitespace");
  if (forbiddenSegmentChars.test(segment))
    throw new InvalidTitleError(path, `forbidden character in segment "${segment}"`);
  if (segment.endsWith(".")) throw new InvalidTitleError(path, "segment with trailing dot");
  if (reservedWindowsNames.test(segment))
    throw new InvalidTitleError(path, `reserved device name "${segment}"`);
}
