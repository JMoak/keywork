import { ProviderEmptyResponseError, ProviderHttpError } from "./errors.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AuthHeaders = () => Promise<Record<string, string>>;

export interface StreamingPost {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal?: AbortSignal | undefined;
}

export function bearerHeaders(apiKey: string | undefined): AuthHeaders {
  const headers = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
  return async () => headers;
}

export async function postForStream(
  provider: string,
  fetchFn: FetchLike,
  post: StreamingPost,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchFn(post.url, {
    method: "POST",
    headers: post.headers,
    body: post.body,
    ...(post.signal !== undefined && { signal: post.signal }),
  });
  if (!response.ok) throw await httpFailure(provider, response);
  if (response.body === null) throw new ProviderEmptyResponseError(provider);
  return response.body;
}

async function httpFailure(provider: string, response: Response): Promise<ProviderHttpError> {
  return new ProviderHttpError(
    provider,
    response.status,
    await response.text(),
    response.headers.get("retry-after") ?? undefined,
  );
}
