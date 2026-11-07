import { z } from "zod";
import type { CreatureMail, MessageOutcome } from "../creatures/messages/mail.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";

export interface MessageTarget {
  creature: string;
  mail: Pick<CreatureMail, "send">;
}

export function messageTool(target: MessageTarget): Tool {
  return defineTool({
    name: "message",
    description:
      "Send another creature a short plain-text message by its name. It lands in that creature's conversation as a line from you and reaches its next turn as an untrusted note: it starts no turn, asks for nothing on your behalf and grants nothing. The receiver's inbound policy and the hourly limits decide whether it is delivered, and the answer says which in words. Use it instead of writing files for another creature to find.",
    schema: messageArgs,
    run: async (args) => {
      const draft = draftOf(target.creature, args);
      return sentenceOf(draft.to, await target.mail.send(draft));
    },
  });
}

const messageArgs = z
  .object({
    to: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("The receiving creature's name, as the keeper calls it (for example hal)."),
    text: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("What to say, in plain words; at most 2000 characters."),
    node: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The stable id of the paired machine the creature lives on; leave it out for a creature on this machine.",
      ),
  })
  .strict();

type MessageArgs = z.infer<typeof messageArgs>;

interface MessageDraft {
  from: string;
  to: string;
  text: string;
  node?: string;
}

function draftOf(from: string, args: MessageArgs): MessageDraft {
  const to = args.to.toLowerCase();
  return args.node === undefined
    ? { from, to, text: args.text }
    : { from, to, text: args.text, node: args.node };
}

function sentenceOf(to: string, outcome: MessageOutcome): string {
  if ("refused" in outcome) return `Not delivered: ${outcome.error}.`;
  const { delivered } = outcome;
  const where = delivered.hop === 0 ? "" : ` on ${delivered.machine}`;
  return `Delivered to ${to}${where} (message ${delivered.id}). It reaches ${to}'s next turn as a note from you; ${to} answers, if at all, when it next works.`;
}
