export function toolActivityOf(tool: string, args: unknown): string {
  const subject = subjectOf(args);
  return subject === "" ? tool : `${tool} ${subject}`;
}

const favoredSubjects = ["path", "command", "query", "pattern", "url", "name"];

const longestSubject = 60;

function subjectOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const shown = shownRefOf(record.what);
  if (shown !== undefined) return clipped(shown);
  const key =
    favoredSubjects.find((candidate) => typeof record[candidate] === "string") ??
    Object.keys(record).find((candidate) => typeof record[candidate] === "string");
  const value = key === undefined ? undefined : record[key];
  return typeof value === "string" ? clipped(value) : "";
}

function shownRefOf(what: unknown): string | undefined {
  const first: unknown = Array.isArray(what) ? what[0] : what;
  if (typeof first !== "object" || first === null) return undefined;
  const { ref } = first as Record<string, unknown>;
  return typeof ref === "string" ? ref : undefined;
}

function clipped(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > longestSubject ? `${flat.slice(0, longestSubject - 1)}…` : flat;
}
