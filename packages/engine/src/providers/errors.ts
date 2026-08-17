export class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    body: string,
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
