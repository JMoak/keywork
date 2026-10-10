import type {
  EffortChange,
  EffortLevel,
  ProviderRequest,
  ToolAddition,
  ToolDefinition,
} from "./provider.ts";

export type RequestMarks = Pick<ProviderRequest, "effort" | "effortChanges" | "toolAdditions">;

export class ConversationMarks {
  private offered: Set<string> | undefined;
  private opening: EffortLevel | undefined;
  private stated: EffortLevel | undefined;
  private readonly additions: ToolAddition[] = [];
  private readonly efforts: EffortChange[] = [];

  restateEffort(level: EffortLevel | undefined, before: number): void {
    if (this.offered === undefined || level === undefined || level === this.stated) return;
    this.efforts.push({ before, level });
    this.stated = level;
  }

  forRequest(
    tools: readonly ToolDefinition[],
    effort: EffortLevel | undefined,
    before: number,
  ): RequestMarks {
    if (this.offered === undefined) this.open(tools, effort);
    else this.noteAddedTools(this.offered, tools, before);
    return {
      ...(this.opening !== undefined && { effort: this.opening }),
      ...(this.efforts.length > 0 && { effortChanges: [...this.efforts] }),
      ...(this.additions.length > 0 && { toolAdditions: [...this.additions] }),
    };
  }

  private open(tools: readonly ToolDefinition[], effort: EffortLevel | undefined): void {
    this.offered = new Set(tools.map((tool) => tool.name));
    this.opening = effort;
    this.stated = effort;
  }

  private noteAddedTools(
    offered: Set<string>,
    tools: readonly ToolDefinition[],
    before: number,
  ): void {
    const added = tools.filter((tool) => !offered.has(tool.name)).map(snapshotOf);
    if (added.length === 0) return;
    for (const tool of added) offered.add(tool.name);
    this.additions.push({ before, tools: added });
  }
}

function snapshotOf(tool: ToolDefinition): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
