export class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    body: string,
    readonly retryAfter?: string,
  ) {
    super(describeHttpFailure(provider, status, body));
    this.name = "ProviderHttpError";
  }
}

export class ProviderStreamError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} stream failed: ${excerptOf(detail)}`);
    this.name = "ProviderStreamError";
  }
}

export class ProviderEmptyStreamError extends ProviderStreamError {
  readonly transient = true;

  constructor(provider: string) {
    super(provider, "ended with no reply and no finish reason");
    this.name = "ProviderEmptyStreamError";
  }
}

export class ProviderEmptyResponseError extends Error {
  readonly transient = true;

  constructor(provider: string) {
    super(`${provider} returned an empty response body`);
    this.name = "ProviderEmptyResponseError";
  }
}

function describeHttpFailure(provider: string, status: number, body: string): string {
  const meaning = meaningOf(provider, status, body);
  return meaning === undefined
    ? `${provider} request failed (${status}): ${excerptOf(body)}`
    : `${meaning} · (${status}) ${leadOf(body)}`.trimEnd();
}

function meaningOf(provider: string, status: number, body: string): string | undefined {
  if (status === 401) return `${provider} rejected the key · run keywork connect ${provider}`;
  if (toolUseUnsupported.test(body)) {
    return `this model can't call tools on ${provider} · pick another one`;
  }
  if (unrecognizedModel.test(body)) return `${provider} didn't recognize the model id`;
  return undefined;
}

const toolUseUnsupported = /no endpoints found that support tool use/i;

const unrecognizedModel =
  /is not a valid model id|model_not_found|\bmodel\b.{0,100}?\b(?:does not exist|not found)\b/i;

function excerptOf(text: string): string {
  return withoutAccountIds(text).slice(0, 500);
}

function leadOf(body: string): string {
  return withoutAccountIds(leadingSentence(providerMessageOf(body))).slice(0, 200);
}

function providerMessageOf(body: string): string {
  const reply = parsedJson(body);
  return (
    textAt(reply, "error", "message") ??
    textAt(reply, "error") ??
    textAt(reply, "message") ??
    body.trim()
  );
}

function leadingSentence(text: string): string {
  return text.split(/(?<=\.)\s/, 1)[0] ?? "";
}

function withoutAccountIds(text: string): string {
  return text.replace(accountIdField, `"$1":"[redacted]"`).replace(accountIdToken, "[redacted]");
}

const accountIdField =
  /"([\w-]*(?:user|org|organization|account|customer)[_-]?id)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|\d+)/gi;

const accountIdToken = /\b(?:user|org|acct|account|cus)[_-](?=[a-z]*\d)[a-z0-9]{12,}\b/gi;

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textAt(value: unknown, ...path: readonly string[]): string | undefined {
  const found = path.reduce<unknown>(
    (node, key) => (isRecord(node) ? node[key] : undefined),
    value,
  );
  return typeof found === "string" ? found : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
