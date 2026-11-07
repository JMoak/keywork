import type { PolicyNode } from "./nodes.ts";
import { portWords } from "./ports.ts";
import type { FlowVerdict, Lane, PolicyReport, TagFinding } from "./verify.ts";

export function policyReportLines(report: PolicyReport): string[] {
  return [
    headline(report),
    ...report.lanes.map((lane) => laneLine(lane, report.house)),
    ...report.tags.map(tagLine),
    ...report.cautions.map((caution) => `caution: ${caution}`),
    ...snippetLines(report),
  ];
}

function headline(report: PolicyReport): string {
  const { ports } = report;
  const plane = report.controlPlane === "tailscale" ? "Tailscale" : "Headscale (self-hosted)";
  const parcels = new Set(report.lanes.map(({ to, from }) => (to === report.house ? from : to)));
  const reach =
    parcels.size === 0
      ? "no parcels on the tailnet yet, so only tags were checked"
      : `the house and ${parcels.size === 1 ? "1 parcel" : `${parcels.size} parcels`}`;
  return `policy: stead ports tcp ${ports.tcp} and udp ${portWords(ports.udp)} on a ${plane} control plane, ${reach}`;
}

function laneLine(lane: Lane, house: PolicyNode): string {
  return `${nameOf(lane.from, house)} → ${nameOf(lane.to, house)}: ${lane.flows.map(flowWords).join("; ")}`;
}

function nameOf(node: PolicyNode, house: PolicyNode): string {
  return node === house ? `house ${node.name}` : node.name;
}

function flowWords(flow: FlowVerdict): string {
  const what = `${flow.protocol} ${portWords(flow.ports)}`;
  const by = flow.allowedBy.join(", ");
  if (flow.missing.length === 0) return `${what} allowed by ${by}`;
  if (flow.allowedBy.length === 0) return `${what} not allowed`;
  return `${what} allowed in part by ${by}, missing ${flow.missing.map(portWords).join(", ")}`;
}

function tagLine(finding: TagFinding): string {
  return finding.owned
    ? `tags: ${finding.tag} on ${finding.node} is owned in tagOwners`
    : `tags: ${finding.tag} on ${finding.node} has no tagOwners entry, so the control plane will not keep it`;
}

function snippetLines(report: PolicyReport): string[] {
  if (report.snippet === null) {
    return [
      "policy: every lane is open on the stead ports and every tag has an owner; nothing to paste",
    ];
  }
  return [
    'missing: paste this into the tailnet policy file, merging each entry into its "grants" and "tagOwners" sections',
    JSON.stringify(report.snippet, null, 2),
  ];
}
