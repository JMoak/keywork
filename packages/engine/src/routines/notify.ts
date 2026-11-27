import { quietAt } from "../notices/quiet.ts";
import {
  defaultNotificationSettings,
  type KeeperSettings,
  type NotificationSettings,
  notificationSettingsSchema,
} from "../notices/settings.ts";
import { runTierOf } from "../notices/tier.ts";
import type { NotifyChoice } from "./routine.ts";
import type { NotificationTier } from "./run.ts";

export {
  defaultNotificationSettings,
  type KeeperSettings,
  type NotificationSettings,
  notificationSettingsSchema,
};

export const defaultKeeperSettings: KeeperSettings = {
  settings: defaultNotificationSettings,
  doNotDisturbSince: null,
};

export function tierOf(notify: NotifyChoice, needsKeeper: boolean): NotificationTier {
  return runTierOf(notify, needsKeeper);
}

export function surfaceAt(
  tier: NotificationTier,
  now: number,
  kept: KeeperSettings,
): number | null {
  if (tier === "log") return null;
  const quiet = quietAt(now, kept);
  if (quiet === null) return now;
  return quiet.until === null ? null : Date.parse(quiet.until);
}
