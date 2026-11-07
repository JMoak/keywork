import { z } from "zod";
import { modelProviderNames } from "./brokers.ts";
import { egressRuleSchema } from "./egress.ts";
import { substrateKinds } from "./substrate.ts";

export const creatureSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "a creature is named by a lowercase slug");

export const workshopSpecSchema = z.strictObject({
  creature: creatureSlug.describe("The one creature this workshop belongs to; two never share."),
  substrate: z
    .enum(substrateKinds)
    .describe("sbx is the sealed microVM; host is a bare directory on this node, shown as such."),
  template: z
    .string()
    .regex(/^docker\/sandbox-templates@sha256:[a-f0-9]{64}$/)
    .optional()
    .describe("A digest-pinned sbx shell template; the kit's qualified digest when omitted."),
  disks: z
    .strictObject({
      rootGb: z.number().int().min(8).max(512).default(20),
      dockerGb: z.number().int().min(1).max(512).default(10),
    })
    .default({ rootGb: 20, dockerGb: 10 })
    .describe("Sized at creation because sbx disks cannot grow later (RUN-008)."),
  cpus: z.number().int().min(1).max(64).default(2).describe("Recorded for the workshop pane."),
  memory: z
    .string()
    .regex(/^[1-9][0-9]*[mg]$/)
    .default("4g")
    .describe("Recorded for the workshop pane, such as 4g or 512m."),
  gpu: z
    .boolean()
    .default(false)
    .describe("GPU passthrough is per OS (RUN-012) and deferred past milestone one."),
  egress: z
    .array(egressRuleSchema)
    .default([])
    .describe("Hosts this creature may reach; everything else stays denied (RUN-005)."),
  brokers: z
    .array(z.enum(modelProviderNames))
    .default([])
    .describe("Model-provider credentials the node holds and swaps in on egress (RUN-003)."),
  setup: z
    .string()
    .min(1)
    .optional()
    .describe("A script run once inside the workshop after its first start (RUN-028)."),
});

export type WorkshopSpec = z.infer<typeof workshopSpecSchema>;

export type WorkshopRequest = z.input<typeof workshopSpecSchema>;

export function parseWorkshopSpec(request: unknown): WorkshopSpec | { invalid: string } {
  const parsed = workshopSpecSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  return { invalid: parsed.error.issues.map(describeIssue).join("; ") };
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}
