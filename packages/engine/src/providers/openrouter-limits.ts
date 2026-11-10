import {
  type OpenRouterRouting,
  type ProviderRequest,
  ProviderRequestControlError,
  type ProviderRequestSupport,
} from "../provider.ts";

export function openRouterRequestSupport(baseUrl: string): ProviderRequestSupport | undefined {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol === "https:" &&
      openRouterHosts.has(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.replace(/\/$/, "") === "/api/v1"
    ) {
      return { maxOutputTokens: true, singleAttempt: true, openRouterRouting: true };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function boundedOpenRouterBody(
  provider: string,
  model: string,
  request: ProviderRequest,
  wire: object,
  decorations: Readonly<Record<string, unknown>>,
): object {
  const bounded = request.maxOutputTokens !== undefined || request.openRouterRouting !== undefined;
  if (!bounded) return { ...wire, ...decorations };
  const fail: (message: string) => never = (message) => {
    throw new ProviderRequestControlError(provider, message);
  };
  if (
    request.maxOutputTokens === undefined ||
    request.openRouterRouting === undefined ||
    request.retry !== "never"
  ) {
    fail("bounded calls require maxOutputTokens, explicit OpenRouter routing, and retry: never");
  }
  if (model.startsWith("openrouter/") || model.startsWith("@") || model.includes(":")) {
    fail("bounded calls require a specific model without routing or plugin variants");
  }
  for (const key of Object.keys(decorations)) {
    if (!boundedDecorations.has(key))
      fail(`body decoration "${key}" is not admitted for a bounded call`);
  }
  if (decorations.model !== undefined && decorations.model !== model)
    fail("body decoration cannot change the reserved model");
  const body: Record<string, unknown> = { ...wire, ...decorations };
  const caps = [request.maxOutputTokens];
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const cap = body[key];
    if (cap !== undefined) {
      if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)
        fail(`${key} must be a positive safe integer`);
      caps.push(cap as number);
    }
  }
  delete body.max_completion_tokens;
  body.model = model;
  body.max_tokens = Math.min(...caps);
  body.provider = boundedRouting(request.openRouterRouting, body.provider, fail);
  if (
    body.reasoning !== undefined ||
    request.effort !== undefined ||
    request.thinking !== undefined
  )
    body.reasoning = boundedReasoning(body.reasoning, request, Math.min(...caps), fail);
  body.stream = true;
  body.stream_options = { include_usage: true };
  return body;
}

const openRouterHosts = new Set(["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"]);

const boundedDecorations = new Set([
  "model",
  "provider",
  "max_tokens",
  "max_completion_tokens",
  "usage",
  "stream_options",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "reasoning",
  "verbosity",
]);

function boundedRouting(
  requested: OpenRouterRouting,
  decorated: unknown,
  fail: (message: string) => never,
): object {
  const source = decorated === undefined ? {} : recordOf(decorated, "provider routing", fail);
  const approved = providerNames(requested.only, fail);
  const prior = source.only === undefined ? approved : providerNames(source.only, fail);
  const only = approved.filter((name) => prior.includes(name));
  if (only.length === 0) fail("no provider satisfies both requested and configured routing");
  const previousPrices =
    source.max_price === undefined ? {} : recordOf(source.max_price, "max_price", fail);
  const maxPrice: Record<string, unknown> = { ...previousPrices };
  for (const key of ["prompt", "completion", "request"] as const) {
    const price = requested.maxPrice[key];
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0)
      fail(`max_price.${key} must be a finite nonnegative price`);
    const previous = previousPrices[key];
    if (
      previous !== undefined &&
      (typeof previous !== "number" || !Number.isFinite(previous) || previous < 0)
    )
      fail(`configured max_price.${key} is invalid`);
    maxPrice[key] = previous === undefined ? price : Math.min(price, previous as number);
  }
  const ignore = [
    ...new Set([
      ...(source.ignore === undefined ? [] : providerNames(source.ignore, fail)),
      ...(requested.ignore ?? []),
    ]),
  ];
  return {
    ...source,
    only,
    ...(ignore.length > 0 && { ignore }),
    max_price: maxPrice,
    allow_fallbacks: false,
    require_parameters: true,
  };
}

function boundedReasoning(
  value: unknown,
  request: ProviderRequest,
  outputCap: number,
  fail: (message: string) => never,
): object {
  const reasoning = value === undefined ? {} : recordOf(value, "reasoning", fail);
  for (const key of Object.keys(reasoning)) {
    if (!["effort", "enabled", "exclude", "max_tokens"].includes(key))
      fail(`reasoning.${key} changes an unadmitted billing or context contract`);
  }
  const result: Record<string, unknown> = {
    ...reasoning,
    ...(request.thinking !== undefined && { enabled: request.thinking }),
    ...(request.effort !== undefined && { effort: request.effort }),
  };
  if (
    result.max_tokens !== undefined &&
    (typeof result.max_tokens !== "number" ||
      !Number.isSafeInteger(result.max_tokens) ||
      result.max_tokens < 0 ||
      result.max_tokens > outputCap)
  )
    fail("reasoning budget must fit within the reserved output cap");
  return result;
}

function recordOf(
  value: unknown,
  name: string,
  fail: (message: string) => never,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function providerNames(value: unknown, fail: (message: string) => never): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((name) => typeof name !== "string" || name.trim() === "")
  ) {
    fail("bounded routing requires a nonempty provider allowlist");
  }
  return [...new Set(value as string[])];
}
