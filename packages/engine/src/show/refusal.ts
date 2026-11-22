export type ShowRefusalKind = "invalid" | "missing" | "conflict" | "limited";

export interface ShowRefusal {
  refused: ShowRefusalKind;
  error: string;
}

export const showRefusalStatus: Readonly<Record<ShowRefusalKind, number>> = {
  invalid: 400,
  missing: 404,
  conflict: 409,
  limited: 429,
};

export function refused(refusal: ShowRefusalKind, error: string): ShowRefusal {
  return { refused: refusal, error };
}

export function nothingOfYoursOut(id: string): string {
  return `nothing you set out is out with the id ${id}; shown lists what is out`;
}
