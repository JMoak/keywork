import { z } from "zod";
import type { ToolCallPart } from "../../messages.ts";
import type { ToolDefinition } from "../../provider.ts";
import type { BenchTurn, ExpectedCall } from "./trace.ts";

export interface TurnScore {
  valid: boolean;
  name: boolean;
  schema: boolean;
  arguments: boolean;
  noTool: boolean | null;
  parallel: boolean | null;
}

export function scoreTurn(
  turn: BenchTurn,
  tools: readonly ToolDefinition[],
  calls: readonly ToolCallPart[],
): TurnScore {
  const named = sameNames(turn.expected, calls);
  return {
    valid: calls.every((call) => isObject(call.arguments) && declared(tools, call) !== undefined),
    name: named,
    schema: calls.every((call) => satisfiesDeclaredSchema(tools, call)),
    arguments: turn.expected.every((expected) =>
      calls.some(
        (call) => call.name === expected.name && contains(call.arguments, expected.arguments),
      ),
    ),
    noTool: turn.expected.length === 0 ? calls.length === 0 : null,
    parallel: turn.expected.length > 1 ? named && calls.length === turn.expected.length : null,
  };
}

export function failedTurnScore(turn: BenchTurn): TurnScore {
  return {
    valid: false,
    name: false,
    schema: false,
    arguments: false,
    noTool: turn.expected.length === 0 ? false : null,
    parallel: turn.expected.length > 1 ? false : null,
  };
}

function sameNames(expected: readonly ExpectedCall[], calls: readonly ToolCallPart[]): boolean {
  const wanted = expected.map((call) => call.name).sort();
  const made = calls.map((call) => call.name).sort();
  return wanted.length === made.length && wanted.every((name, i) => name === made[i]);
}

function declared(
  tools: readonly ToolDefinition[],
  call: ToolCallPart,
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === call.name);
}

function satisfiesDeclaredSchema(tools: readonly ToolDefinition[], call: ToolCallPart): boolean {
  const tool = declared(tools, call);
  if (tool === undefined) return false;
  try {
    const schema = z.fromJSONSchema(tool.parameters as Parameters<typeof z.fromJSONSchema>[0]);
    return schema.safeParse(call.arguments).success;
  } catch {
    return false;
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      Object.entries(expected).every(([key, value]) => contains(actual[key], value))
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => contains(actual[i], value))
    );
  }
  return Object.is(actual, expected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
