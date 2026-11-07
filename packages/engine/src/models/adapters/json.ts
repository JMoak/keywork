export function objectAt(value: unknown, ...keys: readonly string[]): Record<string, unknown> {
  const found = valueAt(value, ...keys);
  return isRecord(found) ? found : {};
}

export function arrayAt(value: unknown, ...keys: readonly string[]): unknown[] {
  const found = valueAt(value, ...keys);
  return Array.isArray(found) ? found : [];
}

export function stringAt(value: unknown, ...keys: readonly string[]): string | undefined {
  const found = valueAt(value, ...keys);
  return typeof found === "string" ? found : undefined;
}

export function numberAt(value: unknown, ...keys: readonly string[]): number | undefined {
  const found = valueAt(value, ...keys);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
