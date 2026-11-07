import { z } from "zod";

export class TailscaleFormatError extends Error {
  override readonly name = "TailscaleFormatError";
}

export function parseTailscaleJson<T>(text: string, schema: z.ZodType<T>, what: string): T {
  const parsed = schema.safeParse(readJson(text, what));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? "" : issue.path.join(".");
  throw new TailscaleFormatError(
    `${what} did not match the expected shape at ${where}: ${issue?.message}`,
  );
}

export const int64Id = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform(String);

function readJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text, keepUnsafeIntegersAsText);
  } catch (cause) {
    throw new TailscaleFormatError(`${what} was not JSON`, { cause });
  }
}

// Tailscale's user and node ids are int64 and already sit near Number.MAX_SAFE_INTEGER, so an
// integer that a double cannot hold keeps its source text instead of rounding into another id.
function keepUnsafeIntegersAsText(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  const unsafe =
    typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value);
  return unsafe && context?.source !== undefined ? context.source : value;
}
