import { z } from "zod";
import { parseTailscaleJson } from "./tailscale-json.ts";

export interface ServePosture {
  serving: boolean;
  funnel: string[];
}

export function parseServeConfig(text: string): ServePosture {
  if (text.trim() === "") return { serving: false, funnel: [] };
  return postureOf(parseTailscaleJson(text, serveConfigSchema, "tailscale serve config"));
}

interface ServeConfig {
  TCP?: Record<string, unknown> | null | undefined;
  Web?: Record<string, unknown> | null | undefined;
  Services?: Record<string, unknown> | null | undefined;
  AllowFunnel?: Record<string, boolean> | null | undefined;
  Foreground?: Record<string, ServeConfig> | null | undefined;
}

const entries = z.record(z.string(), z.unknown()).nullish();

const serveConfigSchema: z.ZodType<ServeConfig> = z.lazy(() =>
  z.object({
    TCP: entries,
    Web: entries,
    Services: entries,
    AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
    Foreground: z.record(z.string(), serveConfigSchema).nullish(),
  }),
);

function postureOf(config: ServeConfig): ServePosture {
  const foreground = Object.values(config.Foreground ?? {}).map(postureOf);
  const ownFunnel = Object.entries(config.AllowFunnel ?? {})
    .filter(([, allowed]) => allowed)
    .map(([hostPort]) => hostPort);
  return {
    serving:
      [config.TCP, config.Web, config.Services].some(hasEntries) ||
      foreground.some((posture) => posture.serving),
    funnel: [...ownFunnel, ...foreground.flatMap((posture) => posture.funnel)],
  };
}

function hasEntries(record: Record<string, unknown> | null | undefined): boolean {
  return record !== null && record !== undefined && Object.keys(record).length > 0;
}
