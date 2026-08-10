import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigningInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}

export function credentialsFromEnv(
  env: Record<string, string | undefined>,
): AwsCredentials | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (isBlank(accessKeyId) || isBlank(secretAccessKey)) return undefined;
  const sessionToken = env.AWS_SESSION_TOKEN;
  return {
    accessKeyId,
    secretAccessKey,
    ...(isBlank(sessionToken) ? {} : { sessionToken }),
  };
}

export function regionFromEnv(env: Record<string, string | undefined>): string | undefined {
  return [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((value) => !isBlank(value));
}

export function signRequest(input: SigningInput): Record<string, string> {
  const amzDate = amzTimestamp(input.now);
  const payloadHash = sha256Hex(input.body);
  const headers = requestHeaders(input, amzDate);
  const headerNames = Object.keys(headers).sort();
  const scope = `${amzDate.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const signature = hmacHex(
    signingKey(input, amzDate.slice(0, 8)),
    stringToSign(amzDate, scope, canonicalRequest(input, headers, headerNames, payloadHash)),
  );
  const credential = `${input.credentials.accessKeyId}/${scope}`;
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${headerNames.join(";")}, Signature=${signature}`,
  };
}

export function canonicalRequest(
  input: SigningInput,
  headers: Record<string, string>,
  headerNames: readonly string[],
  payloadHash: string,
): string {
  return [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url),
    headerNames.map((name) => `${name}:${headers[name]?.trim() ?? ""}\n`).join(""),
    headerNames.join(";"),
    payloadHash,
  ].join("\n");
}

export function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function requestHeaders(input: SigningInput, amzDate: string): Record<string, string> {
  const lowercased = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...lowercased,
    host: input.url.host,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken !== undefined && {
      "x-amz-security-token": input.credentials.sessionToken,
    }),
  };
}

// SigV4 canonicalizes the path by URI-encoding the already-encoded request path
// (double encoding) for every service except S3.
function canonicalPath(url: URL): string {
  return rfc3986Encode(url.pathname).replace(/%2F/gi, "/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [rfc3986Encode(name), rfc3986Encode(value)] as const)
    .sort(([a, aValue], [b, bValue]) => (a === b ? compare(aValue, bValue) : compare(a, b)))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function stringToSign(amzDate: string, scope: string, canonical: string): string {
  return ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
}

function signingKey(input: SigningInput, dateStamp: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${input.credentials.secretAccessKey}`), dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  return hmac(kService, "aws4_request");
}

function amzTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value === "";
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}
