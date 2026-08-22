export const slugGrammar = "lowercase letters, digits, and inner hyphens";

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const reservedDeviceNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function slugProblem(candidate: string): string | undefined {
  if (!slugPattern.test(candidate)) return `use ${slugGrammar}`;
  if (reservedDeviceNames.test(candidate)) return "reserved device name";
  return undefined;
}

export function isSlug(candidate: string): boolean {
  return slugProblem(candidate) === undefined;
}
