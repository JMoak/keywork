import { textMessage } from "../../messages.ts";
import type { Provider } from "../../provider.ts";
import type {
  CurationJudgmentPort,
  DailyEntryCandidate,
  PairVerdict,
  PromotionProposal,
} from "../gardener.ts";
import type { Note } from "../notes.ts";

export interface ClosingAgentOptions {
  provider: Provider;
  direction?: string | undefined;
  onDegrade?: ((reason: string) => void) | undefined;
}

export function closingJudgment(options: ClosingAgentOptions): CurationJudgmentPort {
  let degraded = false;
  const degrade = (cause: unknown): void => {
    if (!degraded) options.onDegrade?.(reasonOf(cause));
    degraded = true;
  };
  return {
    id: `closing:${options.provider.name}`,
    proposePromotions: async (entries) => {
      if (degraded || entries.length === 0) return [];
      try {
        const reply = await complete(
          options.provider,
          promotionInstruction(options.direction),
          describeEntries(entries),
        );
        return parsePromotions(reply);
      } catch (cause) {
        degrade(cause);
        return [];
      }
    },
    classifyPair: async (a, b) => {
      if (degraded) return distinctVerdict;
      try {
        const reply = await complete(
          options.provider,
          pairInstruction(options.direction),
          describePair(a, b),
        );
        return parseVerdict(reply);
      } catch (cause) {
        degrade(cause);
        return distinctVerdict;
      }
    },
  };
}

const distinctVerdict: PairVerdict = { relation: "distinct", confidence: 0 };

const promotionLead =
  "You are the closing distiller for a keywork arc. Read the arc's daily log entries and " +
  "propose the durable notes worth keeping in the workspace garden. Reply with only a JSON " +
  'array of objects shaped {"entryId": string, "title": string, "body": string, ' +
  '"confidence": number from 0 to 1}. entryId must be one of the ids given. Propose nothing ' +
  "when nothing is durable.";

const pairLead =
  "You curate a keywork memory garden. Decide how note a relates to note b. Reply with only " +
  'a JSON object shaped {"relation": "duplicate" | "supersedes" | "contradiction" | ' +
  '"distinct", "confidence": number from 0 to 1, "keep": "a" | "b" (optional), ' +
  '"mergedBody": string (optional, for duplicates)}.';

function promotionInstruction(direction: string | undefined): string {
  return withDirection(promotionLead, direction);
}

function pairInstruction(direction: string | undefined): string {
  return withDirection(pairLead, direction);
}

function withDirection(lead: string, direction: string | undefined): string {
  if (direction === undefined) return lead;
  return `${lead} The human closing this arc steered the distillation: "${direction}". Favor what serves it.`;
}

function describeEntries(entries: readonly DailyEntryCandidate[]): string {
  return entries
    .map(
      (entry) => `${entry.id} | ${entry.date} ${entry.time} | ${entry.provenance} | ${entry.text}`,
    )
    .join("\n");
}

function describePair(a: Note, b: Note): string {
  return [`a: ${a.title}`, a.body.trimEnd(), "", `b: ${b.title}`, b.body.trimEnd()].join("\n");
}

async function complete(provider: Provider, instruction: string, input: string): Promise<string> {
  let text = "";
  const request = {
    systemPrompt: instruction,
    messages: [textMessage("user" as const, input)],
    tools: [],
  };
  for await (const delta of provider.stream(request)) {
    if (delta.type === "text") text += delta.text;
  }
  return text;
}

function parsePromotions(reply: string): PromotionProposal[] {
  const parsed = extractJson(reply, "[", "]");
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((candidate) => {
    const proposal = asPromotion(candidate);
    return proposal === undefined ? [] : [proposal];
  });
}

function asPromotion(candidate: unknown): PromotionProposal | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const { entryId, title, body, confidence } = candidate as Record<string, unknown>;
  if (typeof entryId !== "string" || typeof title !== "string" || typeof body !== "string")
    return undefined;
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return undefined;
  return { entryId, title, body, confidence: clamp01(confidence) };
}

function parseVerdict(reply: string): PairVerdict {
  const parsed = extractJson(reply, "{", "}");
  if (typeof parsed !== "object" || parsed === null) return distinctVerdict;
  const { relation, confidence, keep, mergedBody } = parsed as Record<string, unknown>;
  if (
    relation !== "duplicate" &&
    relation !== "supersedes" &&
    relation !== "contradiction" &&
    relation !== "distinct"
  )
    return distinctVerdict;
  return {
    relation,
    confidence:
      typeof confidence === "number" && !Number.isNaN(confidence) ? clamp01(confidence) : 0,
    ...((keep === "a" || keep === "b") && { keep }),
    ...(typeof mergedBody === "string" && { mergedBody }),
  };
}

function extractJson(reply: string, open: string, close: string): unknown {
  const start = reply.indexOf(open);
  const end = reply.lastIndexOf(close);
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
