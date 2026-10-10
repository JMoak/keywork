export const skillNameLimit = 64;
export const skillDescriptionLimit = 1024;

export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(
      `invalid skill name "${name}"; use up to ${skillNameLimit} lowercase letters, digits and single hyphens, like release-tag`,
    );
    this.name = "InvalidSkillNameError";
  }
}

export class InvalidSkillDescriptionError extends Error {
  constructor(length: number) {
    super(
      `a skill description needs 1 to ${skillDescriptionLimit} characters; this one has ${length}`,
    );
    this.name = "InvalidSkillDescriptionError";
  }
}

export function validatedSkillName(name: string): string {
  if (name.length <= skillNameLimit && skillNamePattern.test(name)) return name;
  throw new InvalidSkillNameError(name);
}

export function validatedSkillDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length >= 1 && trimmed.length <= skillDescriptionLimit) return trimmed;
  throw new InvalidSkillDescriptionError(trimmed.length);
}

export function skillNameFrom(words: string): string | undefined {
  const slug = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, skillNameLimit)
    .replace(/^-+|-+$/g, "");
  return skillNamePattern.test(slug) ? slug : undefined;
}

const skillNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
