import { z } from "zod";
import { creatureSlug } from "../../mesh/grants/grant.ts";
import { base64urlPattern } from "../../mesh/pairing/canonical.ts";
import type { CreatureOrigin } from "../threads.ts";

export const meshMessagesPath = "/mesh/messages";

export interface MessageLimits {
  hops: number;
  perSenderHourly: number;
  perInboxHourly: number;
  maxChars: number;
}

export const defaultMessageLimits: MessageLimits = {
  hops: 1,
  perSenderHourly: 12,
  perInboxHourly: 50,
  maxChars: 2000,
};

export interface MessageOrigin extends CreatureOrigin {
  node: string;
  machine: string;
}

export type MessageDraft = z.output<ReturnType<typeof messageDraftSchema>>;

export type CreatureMessage = z.output<ReturnType<typeof creatureMessageSchema>>;

export interface Arrival {
  message: unknown;
  caller: ArrivalCaller;
}

export interface ArrivalCaller {
  stableId: string;
  name: string;
  userId: string | null;
  tags: string[];
}

export function messageDraftSchema(limits: MessageLimits) {
  return z
    .object({
      from: slug,
      to: slug,
      node: z.string().trim().min(1).max(128).optional(),
      text: messageText(limits),
      hop: z.number().int().min(0).max(64).optional(),
    })
    .strict();
}

export function creatureMessageSchema(limits: MessageLimits) {
  return z
    .object({
      id: z.string().regex(base64urlPattern).min(8).max(64),
      from: slug,
      to: slug,
      text: messageText(limits),
      hop: z.number().int().min(1),
    })
    .strict();
}

export function arrivalSchema(limits: MessageLimits) {
  const field = z.string().min(1).max(256);
  return z
    .object({
      message: creatureMessageSchema(limits),
      caller: z
        .object({
          stableId: field,
          name: field,
          userId: field.nullable(),
          tags: z.array(field).max(32),
        })
        .strict(),
    })
    .strict();
}

export function messageLine(origin: MessageOrigin, text: string, local: boolean): string {
  const sender = local ? origin.creature : `${origin.creature} on ${origin.machine}`;
  return `Message from ${sender}: ${text}`;
}

export function firstIssueOf(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "not a message";
  return first.path.length === 0 ? first.message : `${first.path.join(".")}: ${first.message}`;
}

const slug = z.string().regex(creatureSlug, "a creature is named by its slug");

function messageText(limits: MessageLimits) {
  return z
    .string()
    .trim()
    .min(1, "a message says something")
    .max(limits.maxChars, `a message is at most ${limits.maxChars} characters`)
    .refine(isPlainText, "a message is plain text, without control characters");
}

const lineControls = new Set(["\n", "\r", "\t"]);

function isPlainText(text: string): boolean {
  return [...text].every((char) => lineControls.has(char) || !isControl(char));
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}
