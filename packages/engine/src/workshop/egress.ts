import { z } from "zod";

export const httpMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type HttpMethod = (typeof httpMethods)[number];

export const generalWebMethods: readonly HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

export type EgressRule =
  | { readonly host: string; readonly methods: "any" | readonly HttpMethod[] }
  | { readonly host: string; readonly port: number };

export interface EgressPlan {
  readonly commands: readonly (readonly string[])[];
  readonly allowed: readonly string[];
  readonly conflicts: readonly string[];
}

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const egressHost = z
  .string()
  .transform((host) => host.trim().toLowerCase())
  .refine((host) => !host.includes("*"), {
    message: "wildcards never reach a workshop's egress; name each host",
  })
  .refine((host) => hostnamePattern.test(host), {
    message: "a host is a bare DNS name such as api.github.com, with no scheme, port or path",
  });

export const egressRuleSchema = z
  .strictObject({
    host: egressHost,
    port: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .optional()
      .describe("Non-HTTP TCP such as SSH on 22, opened only by an explicit host:port (RUN-006)."),
    methods: z
      .union([z.literal("any"), z.array(z.enum(httpMethods)).min(1)])
      .optional()
      .describe("General web egress is GET, HEAD and OPTIONS unless a rule names more (RUN-031)."),
  })
  .refine((rule) => rule.port === undefined || rule.methods === undefined, {
    message: "a port rule is plain TCP and carries no methods",
  })
  .transform(
    (rule): EgressRule =>
      rule.port === undefined
        ? { host: rule.host, methods: rule.methods ?? generalWebMethods }
        : { host: rule.host, port: rule.port },
  );

export function renderSbxEgress(
  sandbox: string,
  rules: readonly EgressRule[],
  inherited: readonly string[],
): EgressPlan {
  const conflicts = inherited.flatMap((resource) => conflictsWith(resource, rules));
  const pruned = unique(inherited).filter((resource) => !wantedExactly(resource, rules));
  return {
    commands: [
      ...pruned.map((resource) => sandboxRule("deny", sandbox, resource)),
      ...rules.map((rule) => allowCommand(sandbox, rule)),
    ],
    allowed: unique(rules.map(resourceOf)),
    conflicts,
  };
}

export function resourceOf(rule: EgressRule): string {
  return "port" in rule ? `${rule.host}:${rule.port}` : rule.host;
}

export function patternCovers(pattern: string, host: string): boolean {
  const resource = withoutPort(pattern.toLowerCase());
  const target = withoutPort(host.toLowerCase());
  if (resource === "*" || resource === "**") return true;
  if (resource.startsWith("*.")) return target.endsWith(resource.slice(1));
  return resource === target;
}

function allowCommand(sandbox: string, rule: EgressRule): string[] {
  const allow = sandboxRule("allow", sandbox, resourceOf(rule));
  if ("port" in rule || rule.methods === "any") return allow;
  return [...allow, ...rule.methods.flatMap((method) => ["--method", method])];
}

function sandboxRule(decision: "allow" | "deny", sandbox: string, resource: string): string[] {
  return ["policy", decision, "network", "--sandbox", sandbox, resource];
}

function conflictsWith(resource: string, rules: readonly EgressRule[]): string[] {
  if (wantedExactly(resource, rules)) return [];
  return rules
    .filter((rule) => patternCovers(resource, rule.host))
    .map(
      (rule) =>
        `${resourceOf(rule)} is also allowed by the inherited rule ${resource}, which this workshop must deny; remove it with: sbx policy rm network --resource ${resource}`,
    );
}

function wantedExactly(resource: string, rules: readonly EgressRule[]): boolean {
  return rules.some((rule) => resourceOf(rule) === resource && isUnrestricted(rule));
}

function isUnrestricted(rule: EgressRule): boolean {
  return "port" in rule || rule.methods === "any";
}

function withoutPort(resource: string): string {
  const colon = resource.lastIndexOf(":");
  return colon === -1 ? resource : resource.slice(0, colon);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
