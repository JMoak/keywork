import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const providers = [
  {
    name: "openrouter",
    label: "OpenRouter — one key, hundreds of models",
    url: "https://openrouter.ai/keys",
    prefix: "sk-or-",
  },
  {
    name: "openai",
    label: "OpenAI — direct",
    url: "https://platform.openai.com/api-keys",
    prefix: "sk-",
  },
] as const;

export async function runSetup(): Promise<number> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("keywork setup — connect a model provider\n");
    providers.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${provider.label}`);
      console.log(`     get a key: ${provider.url}`);
    });

    const choice = (await readline.question("\nProvider [1]: ")).trim() || "1";
    const provider = providers[Number(choice) - 1];
    if (provider === undefined) {
      console.error(`"${choice}" is not an option`);
      return 1;
    }

    const key = (await readline.question(`${provider.name} API key: `)).trim();
    if (key === "") {
      console.error("No key entered — nothing saved.");
      return 1;
    }
    if (!key.startsWith(provider.prefix)) {
      console.log(`note: expected the key to start with "${provider.prefix}" — saving anyway.`);
    }

    const file = await saveApiKey(provider.name, key);
    console.log(`\nSaved to ${file}`);
    console.log("keywork will use it automatically; environment variables still take precedence.");
    console.log(`Try it:  keywork panes`);
    return 0;
  } finally {
    readline.close();
  }
}

export async function saveApiKey(provider: string, key: string): Promise<string> {
  const dir = join(homedir(), ".keywork");
  const file = join(dir, "keywork.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readFile(file, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  const apiKeys = { ...(existing.apiKeys as Record<string, string> | undefined), [provider]: key };
  const merged = { ...existing, apiKeys };
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
