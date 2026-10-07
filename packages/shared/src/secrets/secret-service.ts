import { failed, invoke, serviceName } from "./backend.ts";
import type { CommandRunner } from "./command.ts";
import type { SecretVault } from "./vault.ts";

const backend = "secret service";

export function secretServiceVault(run: CommandRunner): SecretVault {
  const attributes = (name: string) => ["service", serviceName, "account", name];
  return {
    backend,
    store: async (name, value) => {
      const args = ["store", `--label=${serviceName} ${name}`, ...attributes(name)];
      const result = await invoke(backend, run, "secret-tool", args, value);
      if (result.code !== 0) throw failed(backend, result);
    },
    lookup: async (name) => {
      const result = await invoke(backend, run, "secret-tool", ["lookup", ...attributes(name)]);
      if (result.code === 0) return result.stdout;
      if (result.stderr.trim() === "") return undefined;
      throw failed(backend, result);
    },
    forget: async (name) => {
      const result = await invoke(backend, run, "secret-tool", ["clear", ...attributes(name)]);
      if (result.code !== 0 && result.stderr.trim() !== "") throw failed(backend, result);
    },
  };
}
