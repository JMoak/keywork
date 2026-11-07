export function versionAtLeast(version: string | null, minimum: string): boolean {
  if (version === null) return false;
  const actual = numericParts(version);
  const floor = numericParts(minimum);
  for (let index = 0; index < Math.max(actual.length, floor.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function fingerprintId(kind: string, version: string | null): string {
  return `${kind}@${version ?? "unknown"}`;
}

function numericParts(version: string): number[] {
  const core = version.replace(/^[vb]/, "").split(/[-+]/)[0] ?? "";
  return core.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
