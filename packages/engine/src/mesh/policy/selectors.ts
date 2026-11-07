import { BlockList, isIP } from "node:net";
import type { PolicyDocument } from "./document.ts";
import { isTagged, type PolicyNode } from "./nodes.ts";

export type Match = "yes" | "no" | "unresolved";

export function matchesSource(selector: string, node: PolicyNode, policy: PolicyDocument): Match {
  return selector === "autogroup:self" ? "no" : matches(selector, node, policy, null);
}

export function matchesDestination(
  selector: string,
  node: PolicyNode,
  source: PolicyNode,
  policy: PolicyDocument,
): Match {
  return matches(selector, node, policy, source);
}

export function anyMatch(results: readonly Match[]): Match {
  if (results.includes("yes")) return "yes";
  return results.includes("unresolved") ? "unresolved" : "no";
}

function matches(
  selector: string,
  node: PolicyNode,
  policy: PolicyDocument,
  source: PolicyNode | null,
): Match {
  if (selector === "*") return "yes";
  if (selector.startsWith("autogroup:")) return autogroupMatch(selector, node, source);
  if (selector.startsWith("tag:")) return answer(node.tags.includes(selector));
  if (selector.startsWith("group:")) return groupMatch(policy.groups[selector], node);
  if (selector.startsWith("ipset:")) return "unresolved";
  if (selector.startsWith("svc:")) return "no";
  if (selector.includes("@")) return answer(isUser(selector, node));
  const host = policy.hosts[selector];
  if (host !== undefined) return answer(holdsAddressIn(node, host));
  return isAddressOrPrefix(selector) ? answer(holdsAddressIn(node, selector)) : "unresolved";
}

function autogroupMatch(selector: string, node: PolicyNode, source: PolicyNode | null): Match {
  switch (selector) {
    case "autogroup:member":
      return answer(!isTagged(node) && !node.sharee);
    case "autogroup:tagged":
      return answer(isTagged(node));
    case "autogroup:shared":
      return answer(node.sharee);
    case "autogroup:danger-all":
      return "yes";
    case "autogroup:internet":
    case "autogroup:nonroot":
      return "no";
    case "autogroup:self":
      return answer(source !== null && sameOwner(source, node));
    default:
      return "unresolved";
  }
}

function groupMatch(members: readonly string[] | undefined, node: PolicyNode): Match {
  if (members === undefined) return "unresolved";
  return answer(members.some((member) => member.includes("@") && isUser(member, node)));
}

function isUser(selector: string, node: PolicyNode): boolean {
  if (isTagged(node) || node.login === null) return false;
  return (
    node.login === selector || (selector.endsWith("@") && node.login === selector.slice(0, -1))
  );
}

function sameOwner(source: PolicyNode, node: PolicyNode): boolean {
  return (
    !isTagged(source) && !isTagged(node) && source.login !== null && source.login === node.login
  );
}

function holdsAddressIn(node: PolicyNode, prefix: string): boolean {
  const list = blockListOf(prefix);
  return list !== null && node.addresses.some((address) => list.check(address, familyOf(address)));
}

function isAddressOrPrefix(selector: string): boolean {
  return blockListOf(selector) !== null;
}

function blockListOf(prefix: string): BlockList | null {
  const [address = "", length] = prefix.split("/");
  const family = isIP(address);
  if (family === 0) return null;
  const bits = length === undefined ? (family === 4 ? 32 : 128) : Number(length);
  if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return null;
  const list = new BlockList();
  list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
  return list;
}

function familyOf(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 6 ? "ipv6" : "ipv4";
}

function answer(yes: boolean): Match {
  return yes ? "yes" : "no";
}
