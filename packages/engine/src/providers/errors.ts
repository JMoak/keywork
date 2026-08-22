export class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    body: string,
    readonly retryAfter?: string,
  ) {
    super(`${provider} request failed (${status}): ${body.slice(0, 500)}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderStreamError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} stream failed: ${detail.slice(0, 500)}`);
    this.name = "ProviderStreamError";
  }
}

export class ProviderEmptyResponseError extends Error {
  readonly transient = true;

  constructor(provider: string) {
    super(`${provider} returned an empty response body`);
    this.name = "ProviderEmptyResponseError";
  }
}
