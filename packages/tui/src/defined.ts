export type Defined<Seams> = { [Key in keyof Seams]?: Exclude<Seams[Key], undefined> };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function definedOnly<Seams extends object>(seams: Seams): Defined<Seams> {
  return Object.fromEntries(
    Object.entries(seams).filter(([, value]) => value !== undefined),
  ) as Defined<Seams>;
}
