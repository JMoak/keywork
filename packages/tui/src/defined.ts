export type Defined<Seams> = { [Key in keyof Seams]?: Exclude<Seams[Key], undefined> };

export function definedOnly<Seams extends object>(seams: Seams): Defined<Seams> {
  return Object.fromEntries(
    Object.entries(seams).filter(([, value]) => value !== undefined),
  ) as Defined<Seams>;
}
