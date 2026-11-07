import { digestOf } from "../../mesh/pairing/canonical.ts";
import type { MessageSender } from "../inbound.ts";
import type { MessageLimits } from "./message.ts";

export interface Envelope {
  id: string;
  sender: MessageSender;
  to: string;
  text: string;
  hop: number;
}

export interface MessageGuard {
  refusal(envelope: Envelope): GuardRefusal | undefined;
  delivered(envelope: Envelope): void;
}

export interface GuardRefusal {
  refused: "invalid" | "repeat" | "limited";
  error: string;
}

export const guardWindowMs = 60 * 60_000;

export function messageGuard(limits: MessageLimits, now: () => number): MessageGuard {
  const bySender = new Map<string, number[]>();
  const byInbox = new Map<string, number[]>();
  const recent = new Map<string, number>();
  const seen = new Map<string, number>();

  const forgetOlder = (): void => {
    const horizon = now() - guardWindowMs;
    for (const times of [bySender, byInbox]) {
      for (const [key, held] of times) {
        const kept = held.filter((at) => at > horizon);
        if (kept.length === 0) times.delete(key);
        else times.set(key, kept);
      }
    }
    for (const held of [recent, seen]) {
      for (const [key, at] of held) if (at <= horizon) held.delete(key);
    }
  };

  return {
    refusal: (envelope) => {
      forgetOlder();
      const sender = senderKey(envelope.sender);
      const name = senderName(envelope.sender);
      if (envelope.hop > limits.hops) return invalid(hopWords(envelope.hop, limits.hops));
      if (seen.has(envelope.id)) return repeat(`message ${envelope.id} was already delivered`);
      if (recent.has(repeatKey(envelope)))
        return repeat(
          `${name} sent ${envelope.to} the same words within the hour; the repeat is dropped`,
        );
      if ((bySender.get(sender)?.length ?? 0) >= limits.perSenderHourly)
        return limited(
          `${name} has sent ${limits.perSenderHourly} messages this hour, the most a creature may send; try again later`,
        );
      if ((byInbox.get(envelope.to)?.length ?? 0) >= limits.perInboxHourly)
        return limited(
          `${envelope.to} has received ${limits.perInboxHourly} messages this hour, the most its conversation takes; try again later`,
        );
      return undefined;
    },
    delivered: (envelope) => {
      const at = now();
      remember(bySender, senderKey(envelope.sender), at);
      remember(byInbox, envelope.to, at);
      recent.set(repeatKey(envelope), at);
      seen.set(envelope.id, at);
    },
  };
}

function hopWords(hop: number, hops: number): string {
  const crossings = hops === 1 ? "one machine" : `${hops} machines`;
  return `the message has crossed ${hop} machines and may cross at most ${crossings}`;
}

function senderKey(sender: MessageSender): string {
  return `${sender.node} ${sender.creature}`;
}

function senderName(sender: MessageSender): string {
  return `${sender.creature} on ${sender.machine}`;
}

function repeatKey(envelope: Envelope): string {
  return digestOf({ sender: senderKey(envelope.sender), to: envelope.to, text: envelope.text });
}

function remember(times: Map<string, number[]>, key: string, at: number): void {
  times.set(key, [...(times.get(key) ?? []), at]);
}

function invalid(error: string): GuardRefusal {
  return { refused: "invalid", error };
}

function repeat(error: string): GuardRefusal {
  return { refused: "repeat", error };
}

function limited(error: string): GuardRefusal {
  return { refused: "limited", error };
}
