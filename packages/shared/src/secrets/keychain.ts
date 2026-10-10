import { failed, invoke, serviceName } from "./backend.ts";
import type { CommandRunner } from "./command.ts";
import type { SecretVault } from "./vault.ts";

const backend = "macos keychain";
const itemNotFound = 44;

export function keychainVault(run: CommandRunner): SecretVault {
  const item = (name: string) => ["-s", serviceName, "-a", name];
  return {
    backend,
    store: async (name, value) => {
      // `security` takes the password only from argv or an interactive tty prompt.
      const args = ["add-generic-password", "-U", ...item(name), "-w", value];
      const result = await invoke(backend, run, "security", args);
      if (result.code !== 0) throw failed(backend, result);
    },
    lookup: async (name) => {
      const args = ["find-generic-password", ...item(name), "-w"];
      const result = await invoke(backend, run, "security", args);
      if (result.code === itemNotFound) return undefined;
      if (result.code !== 0) throw failed(backend, result);
      return result.stdout.replace(/\n$/, "");
    },
    forget: async (name) => {
      const result = await invoke(backend, run, "security", [
        "delete-generic-password",
        ...item(name),
      ]);
      if (result.code !== 0 && result.code !== itemNotFound) throw failed(backend, result);
    },
  };
}
