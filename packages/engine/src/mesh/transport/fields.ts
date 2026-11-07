import { z } from "zod";

export const displayText = z.string().catch("");

export const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? false);

export const stringList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);

export const optionalTimestamp = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => (value === null || value === undefined || value === "" ? null : value));
