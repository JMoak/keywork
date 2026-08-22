export interface NamedSecret {
  name: string;
  value: string;
}

export function redactForPersistence(text: string, secrets: readonly NamedSecret[]): string {
  return redactShapes(redactExactValues(text, secrets));
}

const minimumSecretLength = 6;
const shapes: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "private-key",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-key" },
  { pattern: /\bxox[baprs]-[\w-]{10,}/g, label: "slack" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, label: "npm" },
  { pattern: /\bgh[pousr]_\w{36,}/g, label: "github" },
  { pattern: /\bgithub_pat_\w{22,}/g, label: "github" },
  { pattern: /\bglpat-[\w-]{20,}/g, label: "gitlab" },
  { pattern: /\bsk-[\w-]{8,}/g, label: "key" },
  { pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi, label: "bearer" },
  { pattern: /(?<=:\/\/)[^/\s:@]+:[^/\s@]+(?=@)/g, label: "url-credentials" },
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
