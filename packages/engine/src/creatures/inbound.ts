import { z } from "zod";
import { creatureSlug } from "../mesh/grants/grant.ts";

export type InboundPolicy = "nobody" | "paired" | NamedSenders;

export interface NamedSenders {
  named: string[];
}

export interface MessageSender {
  creature: string;
  node: string;
  machine: string;
}

export type InboundVerdict = { admitted: true } | { admitted: false; reason: string };

export const defaultInbound: InboundPolicy = "paired";

export const maxNamedSenders = 64;

export const inboundPolicySchema = z.union([
  z.enum(["nobody", "paired"]),
  z
    .object({
      named: z
        .array(
          z
            .string()
            .refine(
              isSenderHandle,
              "a sender is a creature slug, optionally followed by @ and its machine's name or StableID",
            ),
        )
        .min(1)
        .max(maxNamedSenders),
    })
    .strict(),
]);

export function inboundOf(file: { inbound?: InboundPolicy | undefined }): InboundPolicy {
  return file.inbound ?? defaultInbound;
}

export function admitsSender(
  policy: InboundPolicy,
  receiver: string,
  sender: MessageSender,
): InboundVerdict {
  if (policy === "nobody") return refused(`${receiver} takes messages from nobody`);
  if (policy === "paired" || policy.named.some((handle) => handleNames(handle, sender))) {
    return { admitted: true };
  }
  return refused(
    `${receiver} takes messages only from ${policy.named.join(", ")}, not from ${sender.creature} on ${sender.machine}`,
  );
}

export function isSenderHandle(handle: string): boolean {
  const { creature, machine } = partsOf(handle);
  return creatureSlug.test(creature) && (machine === undefined || /^[^\s@]{1,128}$/.test(machine));
}

function handleNames(handle: string, sender: MessageSender): boolean {
  const { creature, machine } = partsOf(handle);
  if (creature !== sender.creature) return false;
  return machine === undefined || machine === sender.node || machine === sender.machine;
}

function partsOf(handle: string): { creature: string; machine?: string | undefined } {
  const at = handle.indexOf("@");
  return at === -1
    ? { creature: handle }
    : { creature: handle.slice(0, at), machine: handle.slice(at + 1) };
}

function refused(reason: string): InboundVerdict {
  return { admitted: false, reason };
}
