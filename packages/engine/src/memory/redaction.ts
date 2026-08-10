export interface NamedSecret {
  name: string;
  value: string;
}

export function redactForPersistence(text: string, secrets: readonly NamedSecret[]): string {
  return redactShapes(redactExactValues(text, secrets));
}

const minimumSecretLength = 6;
const shapes: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bsk-[\w-]{8,}/g, label: "key" },
  { pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi, label: "bearer" },
];
const longTokenShape = /[A-Za-z0-9_+/=-]{32,}/g;

function redactExactValues(text: string, secrets: readonly NamedSecret[]): string {
  const byLongestValue = secrets
    .filter((secret) => secret.value.length >= minimumSecretLength)
    .sort((a, b) => b.value.length - a.value.length);
  return byLongestValue.reduce(
    (scrubbed, { name, value }) => scrubbed.split(value).join(`‹redacted:${name}›`),
    text,
  );
}

function redactShapes(text: string): string {
  const scrubbed = shapes.reduce(
    (partial, { pattern, label }) => partial.replace(pattern, `‹redacted:${label}›`),
    text,
  );
  return scrubbed.replace(longTokenShape, (token) =>
    looksHighEntropy(token) ? "‹redacted:token›" : token,
  );
}

function looksHighEntropy(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}
