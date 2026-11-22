import type { SettingSeat } from "./lineage.ts";
import { quotedNameOf } from "./naming.ts";
import { refused, type ShowRefusal } from "./refusal.ts";
import type { Setting, SettingAgent, SettingSignal } from "./setting.ts";

export interface SignalCaller extends SettingSeat {
  agent?: SettingAgent | undefined;
}

export interface Signalling {
  id: string;
  signal: SettingSignal | undefined;
}

export interface Signalled {
  setting: Setting;
  before: SettingSignal | undefined;
}

export const criticalsAtOnce = 1;

export function raisedByTheCaller(setting: Setting, caller: SignalCaller): boolean {
  return raiserOf(setting) === raiserOf(caller);
}

export function raiserWords(setting: Setting): string {
  if (setting.agent !== undefined) return setting.agent.name ?? "the agent that set it out";
  return setting.creature ?? "the thread that set it out";
}

export function criticalWithoutReason(setting: Pick<Setting, "what">): ShowRefusal {
  return refused(
    "invalid",
    `critical needs a reason: give why, one sentence the keeper reads on ${quotedNameOf(setting.what)} saying what is wrong`,
  );
}

export function criticalOfAnother(setting: Setting): ShowRefusal {
  return refused(
    "conflict",
    `critical goes only on what you set out yourself, and ${quotedNameOf(setting.what)} was set out by ${raiserWords(setting)}; give it needs-you instead`,
  );
}

export function loweredByAnother(setting: Setting): ShowRefusal {
  return refused(
    "conflict",
    `${quotedNameOf(setting.what)} is critical, raised by ${raiserWords(setting)}, and only it or the keeper may lower it`,
  );
}

export function criticalAlready(held: Setting): ShowRefusal {
  return refused(
    "limited",
    `you may hold one critical at a time, and ${quotedNameOf(held.what)} is critical already; lower it with signal null first, or give this one needs-you`,
  );
}

export const severalCriticals = refused(
  "limited",
  "you may hold one critical at a time, and this raises more than one; raise one, and give the others needs-you",
);

function raiserOf({ agent }: { agent?: SettingAgent | undefined }): string {
  return agent === undefined ? "" : `agent ${agent.name ?? ""}`;
}
