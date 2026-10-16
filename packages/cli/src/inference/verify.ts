import type { FetchLike } from "@keywork/engine";

export interface VerificationRequest {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  fetchFn?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export type VerificationReport =
  | { ok: true; at: string; models: readonly string[] }
  | { ok: false; at: string; reason: string; status?: number };

const defaultTimeoutMs = 10_000;

export async function verifyEndpoint(request: VerificationRequest): Promise<VerificationReport> {
  const at = (request.now ?? (() => new Date()))().toISOString();
  const fetchFn = request.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${request.endpoint}/models`, {
      method: "GET",
      headers: { accept: "application/json", ...request.headers },
      signal: AbortSignal.timeout(request.timeoutMs ?? defaultTimeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        at,
        reason: `HTTP ${response.status} from ${request.endpoint}/models${await excerpt(response)}`,
        status: response.status,
      };
    }
    return { ok: true, at, models: modelIds(await response.json().catch(() => undefined)) };
  } catch (cause) {
    return { ok: false, at, reason: describeFailure(cause, request.endpoint) };
  }
}

function modelIds(payload: unknown): string[] {
  return listedModels(payload)
    .map(modelIdOf)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .sort();
}

function listedModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const { data, models } = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(data)) return data;
  return Array.isArray(models) ? models : [];
}

function modelIdOf(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const { id, name } = entry as { id?: unknown; name?: unknown };
  return id ?? name;
}

async function excerpt(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  return text === "" ? "" : `: ${text.slice(0, 160)}`;
}

function describeFailure(cause: unknown, endpoint: string): string {
  if (cause instanceof Error && cause.name === "TimeoutError")
    return `no answer from ${endpoint} in time`;
  const message = cause instanceof Error ? cause.message : String(cause);
  return `could not reach ${endpoint}: ${message}`;
}
