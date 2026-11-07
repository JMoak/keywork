import type { PortRange } from "../listener/ports.ts";
import type { PolicyDocument, PolicyRule } from "./document.ts";
import { type ControlPlane, isTagged, type PolicyNode, selectorOf } from "./nodes.ts";
import { missingPorts, overlaps, type Protocol, portWords } from "./ports.ts";
import { anyMatch, matchesDestination, matchesSource } from "./selectors.ts";

export interface SteadPorts {
  tcp: number;
  udp: PortRange;
}

export interface PolicyCheck {
  policy: PolicyDocument;
  house: PolicyNode;
  parcels: readonly PolicyNode[];
  ports: SteadPorts;
  controlPlane: ControlPlane;
}

export interface PolicyReport {
  controlPlane: ControlPlane;
  ports: SteadPorts;
  house: PolicyNode;
  lanes: Lane[];
  tags: TagFinding[];
  cautions: string[];
  snippet: PolicySnippet | null;
}

export interface Lane {
  from: PolicyNode;
  to: PolicyNode;
  flows: FlowVerdict[];
}

export interface FlowVerdict {
  protocol: Protocol;
  ports: PortRange;
  allowedBy: string[];
  missing: PortRange[];
}

export interface TagFinding {
  tag: string;
  node: string;
  owned: boolean;
}

export interface PolicySnippet {
  grants: SnippetGrant[];
  tagOwners?: Record<string, string[]>;
}

export interface SnippetGrant {
  src: string[];
  dst: string[];
  ip: string[];
}

export function verifyMeshPolicy(check: PolicyCheck): PolicyReport {
  const lanes = check.parcels.flatMap((parcel) => [
    laneOf(check, check.house, parcel),
    laneOf(check, parcel, check.house),
  ]);
  const tags = tagFindings(check);
  return {
    controlPlane: check.controlPlane,
    ports: check.ports,
    house: check.house,
    lanes,
    tags,
    cautions: cautionsOf(check),
    snippet: snippetOf(check, lanes, tags),
  };
}

export function isPolicyOpen(report: PolicyReport): boolean {
  return report.snippet === null;
}

const headscaleAutogroups = new Set([
  "autogroup:member",
  "autogroup:tagged",
  "autogroup:self",
  "autogroup:internet",
  "autogroup:nonroot",
  "autogroup:danger-all",
]);

function laneOf(check: PolicyCheck, from: PolicyNode, to: PolicyNode): Lane {
  return {
    from,
    to,
    flows: [
      flowOf(check.policy, from, to, "tcp", { first: check.ports.tcp, last: check.ports.tcp }),
      flowOf(check.policy, from, to, "udp", check.ports.udp),
    ],
  };
}

function flowOf(
  policy: PolicyDocument,
  from: PolicyNode,
  to: PolicyNode,
  protocol: Protocol,
  ports: PortRange,
): FlowVerdict {
  const covering = policy.rules
    .filter((rule) => !rule.via && sourceHolds(rule, from, policy))
    .flatMap((rule) =>
      rule.targets
        .filter((target) => matchesDestination(target.selector, to, from, policy) === "yes")
        .flatMap((target) => target.ports)
        .filter(
          (spec) =>
            (spec.protocol === protocol || spec.protocol === "any") && overlaps(spec, ports),
        )
        .map((range) => ({ rule: rule.name, range })),
    );
  return {
    protocol,
    ports,
    allowedBy: [...new Set(covering.map(({ rule }) => rule))],
    missing: missingPorts(
      ports,
      covering.map(({ range }) => range),
    ),
  };
}

function sourceHolds(rule: PolicyRule, node: PolicyNode, policy: PolicyDocument): boolean {
  return anyMatch(rule.sources.map((selector) => matchesSource(selector, node, policy))) === "yes";
}

function tagFindings(check: PolicyCheck): TagFinding[] {
  return [check.house, ...check.parcels].flatMap((node) =>
    node.tags.map((tag) => ({
      tag,
      node: node.name,
      owned: Object.hasOwn(check.policy.tagOwners, tag),
    })),
  );
}

function cautionsOf(check: PolicyCheck): string[] {
  const { policy, house, controlPlane } = check;
  const cautions = policy.rules.flatMap((rule) => ruleCautions(rule, check));
  if (isTagged(house)) {
    cautions.push(
      `this machine carries ${house.tags.join(", ")}: right for a host, wrong for a house, which must stay untagged to keep the keeper's identity and pair consoles`,
    );
  }
  if (controlPlane === "headscale") cautions.push(...headscaleCautions(policy));
  return cautions;
}

function ruleCautions(rule: PolicyRule, check: PolicyCheck): string[] {
  const { policy, house, controlPlane } = check;
  const unresolved = [...rule.sources, ...rule.targets.map(({ selector }) => selector)].filter(
    (selector) => matchesDestination(selector, house, house, policy) === "unresolved",
  );
  const cautions = [...new Set(unresolved)].map(
    (selector) =>
      `${rule.name} names ${selector}, which this machine cannot resolve from the tailnet status; it was not counted`,
  );
  if (rule.via)
    cautions.push(`${rule.name} routes via a router, so it opens no lane between machines`);
  if (rule.posture) {
    cautions.push(
      controlPlane === "headscale"
        ? `${rule.name} sets srcPosture, which Headscale does not support`
        : `${rule.name} also asks for a device posture; it was counted as if the posture holds`,
    );
  }
  return cautions;
}

function headscaleCautions(policy: PolicyDocument): string[] {
  const cautions: string[] = [];
  if (policy.usesPostures)
    cautions.push("the policy defines postures, which Headscale does not support");
  for (const [tag, owners] of Object.entries(policy.tagOwners)) {
    for (const owner of owners) {
      if (owner.startsWith("autogroup:") && !headscaleAutogroups.has(owner)) {
        cautions.push(
          `tagOwners for ${tag} names ${owner}, which Headscale does not know; name the keeper as user@ or a group instead`,
        );
      }
    }
  }
  return cautions;
}

function snippetOf(check: PolicyCheck, lanes: Lane[], tags: TagFinding[]): PolicySnippet | null {
  const grants = missingGrants(check.controlPlane, lanes);
  const unowned = [...new Set(tags.filter(({ owned }) => !owned).map(({ tag }) => tag))];
  if (grants.length === 0 && unowned.length === 0) return null;
  const owner = tagOwnerFor(check);
  return unowned.length === 0
    ? { grants }
    : { grants, tagOwners: Object.fromEntries(unowned.map((tag) => [tag, [owner]])) };
}

function missingGrants(plane: ControlPlane, lanes: Lane[]): SnippetGrant[] {
  const grants = new Map<string, SnippetGrant>();
  for (const lane of lanes) {
    const ip = lane.flows.flatMap(({ protocol, missing }) =>
      missing.map((range) => `${protocol}:${portWords(range)}`),
    );
    if (ip.length === 0) continue;
    const src = selectorOf(lane.from, plane);
    const dst = selectorOf(lane.to, plane);
    const held = grants.get(`${src}\n${dst}`) ?? { src: [src], dst: [dst], ip: [] };
    held.ip = [...new Set([...held.ip, ...ip])];
    grants.set(`${src}\n${dst}`, held);
  }
  return [...grants.values()];
}

function tagOwnerFor(check: PolicyCheck): string {
  const { house, controlPlane } = check;
  if (controlPlane === "tailscale") return "autogroup:admin";
  return selectorOf(house, controlPlane);
}
