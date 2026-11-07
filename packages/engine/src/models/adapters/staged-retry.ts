import { ProviderHttpError } from "../../providers/errors.ts";
import type { FieldMemory } from "./types.ts";

export type Body = Readonly<Record<string, unknown>>;

export async function withStagedRetry<T>(
  send: (body: Body) => Promise<T>,
  body: Body,
  optionalFields: readonly string[],
  memory: FieldMemory | undefined,
): Promise<T> {
  try {
    return await send(body);
  } catch (cause) {
    const present = optionalFields.filter((field) => field in body);
    if (!isOptionalFieldRefusal(cause) || present.length === 0) throw cause;
    const culprits = culpritsOf(cause.message, present);
    const retried = await send(withoutFields(body, culprits));
    for (const field of culprits) memory?.reject(field, cause.status);
    return retried;
  }
}

export function culpritsOf(errorText: string, present: readonly string[]): readonly string[] {
  const named = present.filter((field) => errorText.includes(field));
  return named.length > 0 ? named : present;
}

export function withoutFields(body: Body, fields: readonly string[]): Body {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !fields.includes(key)));
}

export function inMemoryFieldMemory(): FieldMemory & { rejected(): readonly string[] } {
  const rejected = new Set<string>();
  return {
    rejects: (field) => rejected.has(field),
    reject: (field) => {
      rejected.add(field);
    },
    rejected: () => [...rejected],
  };
}

function isOptionalFieldRefusal(cause: unknown): cause is ProviderHttpError {
  return cause instanceof ProviderHttpError && (cause.status === 400 || cause.status === 422);
}
