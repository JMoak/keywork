import type { PermissionResolver, ToolPermission } from "../agent.ts";
import type { Tool } from "../tools.ts";
import {
  definitionList,
  definitionString,
  type ExtensionLoadFailure,
  type LayeredDirs,
  type LayerSource,
  loadLayeredMarkdown,
  type MarkdownDefinition,
} from "./layers.ts";

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  overrides: Partial<Record<ToolPermission, string[]>>;
  prompt: string;
  file: string;
  source: LayerSource;
}

export interface AgentLoad {
  agents: AgentDefinition[];
  failures: ExtensionLoadFailure[];
}

export async function loadAgents(dirs: LayeredDirs): Promise<AgentLoad> {
  const { items, failures } = await loadLayeredMarkdown(dirs, buildAgent);
  return { agents: items, failures };
}

export function restrictTools(tools: readonly Tool[], definition: AgentDefinition): Tool[] {
  if (definition.tools === undefined) return [...tools];
  const allowed = new Set(definition.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function narrowedPermissions(
  definition: AgentDefinition,
  base?: PermissionResolver,
): PermissionResolver {
  const overrides = overrideByTool(definition);
  return (call) => {
    const baseVerdict = base?.(call);
    const override = overrides.get(call.name);
    if (override === undefined) return baseVerdict;
    if (baseVerdict === undefined) return override === "allow" ? undefined : override;
    return stricter(baseVerdict, override);
  };
}

const strictness: Record<ToolPermission, number> = { allow: 0, ask: 1, deny: 2 };

function stricter(left: ToolPermission, right: ToolPermission): ToolPermission {
  return strictness[left] >= strictness[right] ? left : right;
}

function overrideByTool(definition: AgentDefinition): Map<string, ToolPermission> {
  const overrides = new Map<string, ToolPermission>();
  for (const verdict of ["allow", "ask", "deny"] as const) {
    for (const tool of definition.overrides[verdict] ?? []) {
      overrides.set(tool, stricter(overrides.get(tool) ?? "allow", verdict));
    }
  }
  return overrides;
}

function buildAgent(definition: MarkdownDefinition): AgentDefinition {
  const description = definitionString(definition.frontmatter, "description");
  const model = definitionString(definition.frontmatter, "model");
  const tools = definitionList(definition.frontmatter, "tools");
  return {
    name: definition.name,
    ...(description !== undefined && { description }),
    ...(model !== undefined && { model }),
    ...(tools !== undefined && { tools }),
    overrides: {
      ...listedOverride(definition, "allow"),
      ...listedOverride(definition, "ask"),
      ...listedOverride(definition, "deny"),
    },
    prompt: definition.body.trim(),
    file: definition.file,
    source: definition.source,
  };
}

function listedOverride(
  definition: MarkdownDefinition,
  verdict: ToolPermission,
): Partial<Record<ToolPermission, string[]>> {
  const tools = definitionList(definition.frontmatter, verdict);
  return tools === undefined ? {} : { [verdict]: tools };
}
