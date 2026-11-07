import { z } from "zod";

export type ModelClass = "strong" | "loop" | "decide" | "vision";

export const modelClasses: readonly ModelClass[] = ["strong", "loop", "decide", "vision"];

export interface ModelCandidate {
  provider: string;
  model: string;
}

export type ModelPolicySlot = "inherit" | ModelCandidate;

export type ModelPolicy = Record<ModelClass, ModelPolicySlot>;

export type PolicyLevel = "creature" | "workspace" | "user";

export const policyLevels: readonly PolicyLevel[] = ["creature", "workspace", "user"];

export type PolicyLevels = Partial<Record<PolicyLevel, Partial<ModelPolicy> | undefined>>;

const candidateSchema = z.object({
  provider: z.string().min(1).describe("Registered provider name the candidate resolves through."),
  model: z.string().min(1).describe("Model id as the provider serves it."),
});

export const modelPolicySlotSchema = z
  .union([z.literal("inherit"), candidateSchema])
  .default("inherit")
  .describe("A fixed candidate for this class, or inherit from the next policy level out.");

export const modelPolicySchema = z.object({
  strong: modelPolicySlotSchema.describe(
    "Conversation, planning, coding and computer use; needs tools and at least 128K context.",
  ),
  loop: modelPolicySlotSchema.describe(
    "Routine runs, children and tool-heavy iteration; needs tools and measured decode speed.",
  ),
  decide: modelPolicySlotSchema.describe(
    "Gates and calibrated yes/no decisions; needs a decision endpoint or logprobs.",
  ),
  vision: modelPolicySlotSchema.describe(
    "Screen understanding and workshop display reading; needs image input.",
  ),
});

export const cloudFallbackSchema = z
  .boolean()
  .default(false)
  .describe(
    "Privacy flag: may a creature whose chosen model is local fall back to a cloud model? Off keeps its work on your machines.",
  );
