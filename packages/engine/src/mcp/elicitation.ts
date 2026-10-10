import { McpInputRequiredError } from "./errors.ts";
import { asArray, asRecord } from "./wire.ts";

export type ElicitationRequest = FormElicitation | UrlElicitation;

export interface FormElicitation {
  mode: "form";
  server: string;
  key: string;
  message: string;
  fields: ElicitationField[];
}

export interface UrlElicitation {
  mode: "url";
  server: string;
  key: string;
  message: string;
  url: string;
}

export type ElicitationFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "set";

export interface ElicitationField {
  name: string;
  kind: ElicitationFieldKind;
  required: boolean;
  title?: string;
  description?: string;
  default?: unknown;
  options?: readonly string[];
}

export type ElicitationAnswer =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type ElicitationHandler = (request: ElicitationRequest) => Promise<ElicitationAnswer>;

export interface PendingInput {
  requests: ElicitationRequest[];
  requestState: string | undefined;
}

export const elicitationMethod = "elicitation/create";
export const elicitationClientCapability = { form: {}, url: {} } as const;

export function pendingInputOf(server: string, result: Record<string, unknown>): PendingInput {
  const requests = Object.entries(asRecord(result.inputRequests)).map(([key, entry]) =>
    elicitationOf(server, key, asRecord(entry)),
  );
  const requestState = result.requestState;
  return { requests, requestState: typeof requestState === "string" ? requestState : undefined };
}

export function inputResponsesOf(
  answers: ReadonlyMap<string, ElicitationAnswer>,
): Record<string, unknown> {
  return Object.fromEntries(answers);
}

export function validateFormContent(
  fields: readonly ElicitationField[],
  content: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) problems.push(`${field.name} is required`);
      continue;
    }
    if (!fits(field, value)) problems.push(`${field.name} must be ${describeKind(field)}`);
  }
  return problems;
}

export function defaultFormContent(fields: readonly ElicitationField[]): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) if (field.default !== undefined) content[field.name] = field.default;
  return content;
}

export function describeElicitation(request: ElicitationRequest): string {
  if (request.mode === "url") {
    return `${request.server} asks you to open ${request.url} · ${request.message}`;
  }
  const wanted = request.fields.map(describeField).join(", ");
  return wanted.length === 0
    ? `${request.server} asks: ${request.message}`
    : `${request.server} asks: ${request.message} (${wanted})`;
}

function elicitationOf(
  server: string,
  key: string,
  entry: Record<string, unknown>,
): ElicitationRequest {
  if (entry.method !== elicitationMethod) {
    throw new McpInputRequiredError(server, "tools/call", [String(entry.method)]);
  }
  const params = asRecord(entry.params);
  const message = typeof params.message === "string" ? params.message : "";
  if (params.mode === "url") {
    const url = typeof params.url === "string" ? params.url : "";
    if (!isWebUrl(url)) throw new McpInputRequiredError(server, "tools/call", ["url elicitation"]);
    return { mode: "url", server, key, message, url };
  }
  if (params.mode !== undefined && params.mode !== "form") {
    throw new McpInputRequiredError(server, "tools/call", [`${String(params.mode)} elicitation`]);
  }
  return { mode: "form", server, key, message, fields: fieldsOf(asRecord(params.requestedSchema)) };
}

function fieldsOf(schema: Record<string, unknown>): ElicitationField[] {
  const required = new Set(asArray(schema.required).filter((name) => typeof name === "string"));
  return Object.entries(asRecord(schema.properties)).map(([name, raw]) =>
    fieldOf(name, asRecord(raw), required.has(name)),
  );
}

function fieldOf(
  name: string,
  schema: Record<string, unknown>,
  required: boolean,
): ElicitationField {
  const options = enumOptions(schema);
  const kind =
    options === undefined ? primitiveKind(schema.type) : schema.type === "array" ? "set" : "enum";
  return {
    name,
    kind,
    required,
    ...(typeof schema.title === "string" && { title: schema.title }),
    ...(typeof schema.description === "string" && { description: schema.description }),
    ...(schema.default !== undefined && { default: schema.default }),
    ...(options !== undefined && { options }),
  };
}

function primitiveKind(type: unknown): ElicitationFieldKind {
  if (type === "number" || type === "integer" || type === "boolean") return type;
  return "string";
}

function enumOptions(schema: Record<string, unknown>): string[] | undefined {
  const source = schema.type === "array" ? asRecord(schema.items) : schema;
  const plain = asArray(source.enum).filter((value): value is string => typeof value === "string");
  if (plain.length > 0) return plain;
  const titled = asArray(source.oneOf ?? source.anyOf)
    .map((entry) => asRecord(entry).const)
    .filter((value): value is string => typeof value === "string");
  return titled.length > 0 ? titled : undefined;
}

function fits(field: ElicitationField, value: unknown): boolean {
  switch (field.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (field.options?.includes(value) ?? false);
    case "set":
      return (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string" && (field.options?.includes(item) ?? false))
      );
  }
}

function describeKind(field: ElicitationField): string {
  if (field.kind === "enum") return `one of ${field.options?.join(" | ")}`;
  if (field.kind === "set") return `a list drawn from ${field.options?.join(" | ")}`;
  return field.kind === "integer" ? "an integer" : `a ${field.kind}`;
}

function describeField(field: ElicitationField): string {
  const label = field.title ?? field.name;
  return field.required ? label : `${label}?`;
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
