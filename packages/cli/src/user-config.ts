import { homedir } from "node:os";
import { join } from "node:path";
import { type KeyworkConfig, keyworkConfigStore } from "@keywork/shared";

export function userConfigDir(): string {
  return join(homedir(), ".keywork");
}

export async function updateUserConfig(
  mutate: (existing: KeyworkConfig) => KeyworkConfig,
  dir: string = userConfigDir(),
): Promise<string> {
  const store = keyworkConfigStore(join(dir, "keywork.json"));
  store.write(mutate(store.read() ?? {}));
  return store.file;
}

export async function readUserConfig(dir: string = userConfigDir()): Promise<KeyworkConfig> {
  return keyworkConfigStore(join(dir, "keywork.json")).read() ?? {};
}
