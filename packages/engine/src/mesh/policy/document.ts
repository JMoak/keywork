import { z } from "zod";
import { PolicyTextError, parseHuJson } from "./hujson.ts";
import { type PortSpec, parsePortList, protocolOf } from "./ports.ts";

export interface PolicyDocument {
  groups: Readonly<Record<string, readonly string[]>>;
  hosts: Readonly<Record<string, string>>;
  tagOwners: Readonly<Record<string, readonly string[]>>;
  rules: PolicyRule[];
  usesPostures: boolean;
}

export interface PolicyRule {
  name: string;
  sources: string[];
  targets: RuleTarget[];
  posture: boolean;
  via: boolean;
}

export interface RuleTarget {
  selector: string;
  ports: PortSpec[];
}

export function readPolicy(text: string): PolicyDocument {
  const parsed = policySchema.safeParse(lowercaseKeys(parseHuJson(text)));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : issue.path.join(".");
    throw new PolicyTextError(
      `the policy does not read as a tailnet policy at ${where}: ${issue?.message}`,
    );
  }
  const policy = parsed.data;
  return {
    groups: policy.groups ?? {},
    hosts: policy.hosts ?? {},
    tagOwners: policy.tagowners ?? {},
    rules: [...(policy.grants ?? []).map(grantRule), ...(policy.acls ?? []).flatMap(aclRule)],
    usesPostures: policy.postures !== undefined,
  };
}

const selectors = z.array(z.string());

const grantSchema = z.object({
  src: selectors,
  dst: selectors,
  ip: selectors.optional(),
  srcPosture: selectors.optional(),
  via: selectors.optional(),
});

const aclSchema = z.object({
  action: z.string(),
  src: selectors.optional(),
  users: selectors.optional(),
  dst: selectors.optional(),
  ports: selectors.optional(),
  proto: z.union([z.string(), z.number()]).optional(),
  srcPosture: selectors.optional(),
});

const policySchema = z.object({
  groups: z.record(z.string(), selectors).optional(),
  hosts: z.record(z.string(), z.string()).optional(),
  tagowners: z.record(z.string(), selectors).optional(),
  grants: z.array(grantSchema).optional(),
  acls: z.array(aclSchema).optional(),
  postures: z.unknown().optional(),
});

type Grant = z.infer<typeof grantSchema>;
type Acl = z.infer<typeof aclSchema>;

function grantRule(grant: Grant, index: number): PolicyRule {
  const ports = parsePortList(grant.ip ?? []);
  return {
    name: `grants[${index}]`,
    sources: grant.src,
    targets: grant.dst.map((selector) => ({ selector, ports })),
    posture: grant.srcPosture !== undefined,
    via: grant.via !== undefined,
  };
}

function aclRule(acl: Acl, index: number): PolicyRule[] {
  if (acl.action !== "accept") return [];
  const protocol = protocolOf(acl.proto);
  return [
    {
      name: `acls[${index}]`,
      sources: acl.src ?? acl.users ?? [],
      targets: (acl.dst ?? acl.ports ?? []).map((destination) => aclTarget(destination, protocol)),
      posture: acl.srcPosture !== undefined,
      via: false,
    },
  ];
}

function aclTarget(destination: string, protocol: PortSpec["protocol"]): RuleTarget {
  const colon = destination.lastIndexOf(":");
  if (colon === -1) return { selector: destination, ports: [] };
  const ports = parsePortList(destination.slice(colon + 1).split(","));
  return {
    selector: destination.slice(0, colon),
    ports: ports.map((spec) => ({ ...spec, protocol })),
  };
}

// Tailscale reads the top-level section names without regard to case ("ACLs", "acls", "tagOwners").
function lowercaseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key.toLowerCase(), entry]),
  );
}
