import { type AgentColor, agentColors, type SettingAgent } from "./setting.ts";

export class AgentColors {
  private readonly held = new Map<string, AgentColor>();

  coloured(agent: SettingAgent): SettingAgent {
    const key = keyOf(agent);
    const color = this.held.get(key) ?? freeColorFor(key, new Set(this.held.values()));
    this.held.set(key, color);
    return { ...agent, color };
  }

  remember(agent: SettingAgent | undefined): void {
    if (agent?.color === undefined) return;
    const key = keyOf(agent);
    if (!this.held.has(key)) this.held.set(key, agent.color);
  }
}

export function freeColorFor(name: string, taken: ReadonlySet<AgentColor>): AgentColor {
  const first = hashOf(name) % agentColors.length;
  const inTurn = agentColors.map((_, step) => agentColors[(first + step) % agentColors.length]);
  const free = inTurn.find((color) => color !== undefined && !taken.has(color));
  return free ?? inTurn[0] ?? "cyan";
}

function keyOf({ name }: SettingAgent): string {
  return (name ?? "").trim().toLowerCase();
}

function hashOf(text: string): number {
  let hash = 2_166_136_261;
  for (const letter of text) {
    hash ^= letter.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}
