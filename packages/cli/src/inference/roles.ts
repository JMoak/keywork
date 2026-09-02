import type { Provider } from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import type { InferenceRuntime } from "./runtime.ts";

export const closingRole = "closing";

export function roleProvider(
  runtime: InferenceRuntime,
  config: KeyworkConfig,
  role: string,
): Provider | undefined {
  const reference = config.roles?.[role];
  if (reference === undefined) return undefined;
  const resolution = runtime.resolve({ selection: reference });
  return resolution.ok ? runtime.provider(resolution.binding) : undefined;
}
