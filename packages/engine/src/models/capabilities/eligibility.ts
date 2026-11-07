import { localityOf } from "../policy/locality.ts";
import type { ModelClass } from "../policy/types.ts";
import type { CapabilityRecord, Probed } from "./types.ts";

export interface MissingCapability {
  capability: string;
  needs: string;
}

export const strongContextFloor = 131_072;
export const agentContextFloor = 65_536;
export const loopDecodeFloor = 40;

export const eligibilityOrder: readonly ModelClass[] = ["strong", "loop", "decide", "vision"];

export function missingFor(record: CapabilityRecord, modelClass: ModelClass): MissingCapability[] {
  const cloud = localityOf(record.endpoint) === "cloud";
  return classChecks[modelClass]
    .filter((check) => (cloud ? cloudShortfall(check, record) : check.standing(record) !== "met"))
    .map(({ capability, needs }) => ({ capability, needs }));
}

export function eligibleClasses(record: CapabilityRecord): ModelClass[] {
  return eligibilityOrder.filter((modelClass) => missingFor(record, modelClass).length === 0);
}

export function decidesThroughBuiltin(record: CapabilityRecord): boolean {
  return localityOf(record.endpoint) === "cloud" && decisionOrLogprobs.standing(record) !== "met";
}

export function measurementOf(record: CapabilityRecord, capability: string): string {
  const check = everyCheck.find((candidate) => candidate.capability === capability);
  return check === undefined ? `${capability} is unknown` : check.measured(record);
}

type Standing = "met" | "short" | "unknown";

interface CapabilityCheck extends MissingCapability {
  standing(record: CapabilityRecord): Standing;
  measured(record: CapabilityRecord): string;
  measuredOnThisNode: boolean;
}

function cloudShortfall(check: CapabilityCheck, record: CapabilityRecord): boolean {
  return !check.measuredOnThisNode && check.standing(record) === "short";
}

function standingOf<T>(probed: Probed<T>, meets: (value: T) => boolean): Standing {
  if (!probed.known) return "unknown";
  return meets(probed.value) ? "met" : "short";
}

const toolCalls: CapabilityCheck = {
  capability: "tools",
  needs: "tool calls arriving in tool_calls",
  measuredOnThisNode: false,
  standing: (record) => standingOf(record.tools, (value) => value),
  measured: (record) =>
    record.tools.known ? "its tool calls are declared off" : "its tool calls were never verified",
};

function contextAtLeast(floor: number): CapabilityCheck {
  return {
    capability: "contextAllocated",
    needs: `at least ${floor} tokens of context allocated`,
    measuredOnThisNode: false,
    standing: (record) => standingOf(record.contextAllocated, (value) => value >= floor),
    measured: (record) =>
      record.contextAllocated.known
        ? `${record.contextAllocated.value} tokens of context allocated`
        : "its allocated context was never measured",
  };
}

const measuredDecode: CapabilityCheck = {
  capability: "decodeTokensPerSecond",
  needs: `decode measured at or above ${loopDecodeFloor} tok/s on this node`,
  measuredOnThisNode: true,
  standing: (record) =>
    standingOf(record.decodeTokensPerSecond, (value) => value >= loopDecodeFloor),
  measured: (record) =>
    record.decodeTokensPerSecond.known
      ? `decode measured at ${record.decodeTokensPerSecond.value} tok/s`
      : "its decode was never measured on this node",
};

const decisionOrLogprobs: CapabilityCheck = {
  capability: "decisionEndpoint",
  needs: "a decision endpoint or logprobs",
  measuredOnThisNode: true,
  standing: (record) => {
    const endpoint = standingOf(record.decisionEndpoint, (value) => value !== null);
    const logprobs = standingOf(record.logprobs, (value) => value);
    if (endpoint === "met" || logprobs === "met") return "met";
    return endpoint === "short" && logprobs === "short" ? "short" : "unknown";
  },
  measured: () => "no decision endpoint or logprobs was found",
};

const imageInput: CapabilityCheck = {
  capability: "imageInput",
  needs: "image input",
  measuredOnThisNode: false,
  standing: (record) => standingOf(record.imageInput, (value) => value !== "none"),
  measured: (record) =>
    record.imageInput.known ? "it declares no image input" : "its image input was never probed",
};

const classChecks: Readonly<Record<ModelClass, readonly CapabilityCheck[]>> = {
  strong: [toolCalls, contextAtLeast(strongContextFloor)],
  loop: [toolCalls, contextAtLeast(agentContextFloor), measuredDecode],
  decide: [decisionOrLogprobs],
  vision: [imageInput],
};

const everyCheck: readonly CapabilityCheck[] = [
  toolCalls,
  contextAtLeast(strongContextFloor),
  measuredDecode,
  decisionOrLogprobs,
  imageInput,
];
