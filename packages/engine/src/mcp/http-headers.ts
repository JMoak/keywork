import { asRecord } from "./wire.ts";

export type SchemaLookup = (tool: string) => Record<string, unknown> | undefined;

export function modernRequestHeaders(
  method: string,
  params: Record<string, unknown>,
  schemaOf: SchemaLookup,
): Record<string, string> {
  const headers: Record<string, string> = { "mcp-method": method };
  const name = namedTarget(method, params);
  if (name !== undefined) headers["mcp-name"] = headerValue(name);
  if (method === "tools/call" && typeof params.name === "string") {
    Object.assign(headers, parameterHeaders(schemaOf(params.name), asRecord(params.arguments)));
  }
  return headers;
}

export function hasValidHeaderAnnotations(schema: Record<string, unknown>): boolean {
  const annotations = headerAnnotations(schema);
  if (annotations === undefined) return false;
  const names = annotations.map((annotation) => annotation.header.toLowerCase());
  return new Set(names).size === names.length;
}

interface HeaderAnnotation {
  path: readonly string[];
  header: string;
}

const annotationKey = "x-mcp-header";
const headerToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const headerSafe = /^[\x20-\x7e\t]*$/;
const base64Sentinel = /^=\?base64\?.*\?=$/s;
const primitiveTypes: ReadonlySet<unknown> = new Set(["string", "integer", "boolean"]);
const namedMethods: Readonly<Record<string, "name" | "uri">> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

function namedTarget(method: string, params: Record<string, unknown>): string | undefined {
  const field = namedMethods[method];
  if (field === undefined) return undefined;
  const value = params[field];
  return typeof value === "string" ? value : undefined;
}

function parameterHeaders(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { path, header } of headerAnnotations(schema ?? {}) ?? []) {
    const value = valueAt(args, path);
    if (value !== undefined) headers[`mcp-param-${header.toLowerCase()}`] = headerValue(value);
  }
  return headers;
}

function valueAt(args: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = args;
  for (const key of path) current = asRecord(current)[key];
  if (typeof current === "string") return current;
  if (typeof current === "boolean" || typeof current === "number") return String(current);
  return undefined;
}

function headerValue(value: string): string {
  const plain = headerSafe.test(value) && value.trim() === value && !base64Sentinel.test(value);
  if (plain) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function headerAnnotations(schema: Record<string, unknown>): HeaderAnnotation[] | undefined {
  const found: HeaderAnnotation[] = [];
  return collectAnnotations(schema, [], found) ? found : undefined;
}

function collectAnnotations(
  node: unknown,
  path: readonly string[] | undefined,
  found: HeaderAnnotation[],
): boolean {
  if (Array.isArray(node)) return node.every((item) => collectAnnotations(item, undefined, found));
  if (typeof node !== "object" || node === null) return true;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === annotationKey) {
      if (!isPlaceableAnnotation(record, path, value)) return false;
      found.push({ path: path ?? [], header: value });
    } else if (key === "properties" && path !== undefined) {
      for (const [property, child] of Object.entries(asRecord(value))) {
        if (!collectAnnotations(child, [...path, property], found)) return false;
      }
    } else if (!collectAnnotations(value, undefined, found)) {
      return false;
    }
  }
  return true;
}

function isPlaceableAnnotation(
  owner: Record<string, unknown>,
  path: readonly string[] | undefined,
  header: unknown,
): header is string {
  return (
    path !== undefined &&
    path.length > 0 &&
    typeof header === "string" &&
    headerToken.test(header) &&
    primitiveTypes.has(owner.type)
  );
}
