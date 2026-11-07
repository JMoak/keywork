import { ProviderHttpError } from "../../providers/errors.ts";

export type ProviderAnswer =
  | { kind: "answered"; at: string }
  | { kind: "refused"; at: string; status: number };

export interface ProviderAnswers {
  answerOf(provider: string): ProviderAnswer | undefined;
}

export class ProviderAnswerBook implements ProviderAnswers {
  private readonly answers = new Map<string, ProviderAnswer>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  answered(provider: string): void {
    this.answers.set(provider, { kind: "answered", at: this.now().toISOString() });
  }

  failed(provider: string, cause: unknown): void {
    const status = credentialRefusalOf(cause);
    if (status === undefined) return;
    this.answers.set(provider, { kind: "refused", at: this.now().toISOString(), status });
  }

  answerOf(provider: string): ProviderAnswer | undefined {
    return this.answers.get(provider);
  }
}

export const noAnswers: ProviderAnswers = { answerOf: () => undefined };

function credentialRefusalOf(cause: unknown): number | undefined {
  if (!(cause instanceof ProviderHttpError)) return undefined;
  return cause.status === 401 || cause.status === 403 ? cause.status : undefined;
}
