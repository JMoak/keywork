import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { configSchema, type KeyworkConfig } from "@keywork/shared";

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

const enter = new Set(["\r", "\n"]);
const erase = new Set([String.fromCharCode(127), "\b"]);
const interrupt = String.fromCharCode(3);

export async function runSetup(): Promise<number> {
  console.log("keywork setup — connect a model provider\n");
  providers.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider.label}`);
    console.log(`     get a key: ${provider.url}`);
  });

  const choice = (await askLine("\nProvider [1]: ")).trim() || "1";
  const provider = providers[Number(choice) - 1];
  if (provider === undefined) {
    console.error(`"${choice}" is not an option`);
    return 1;
  }

  const key = (await readMaskedLine(`${provider.name} API key: `)).trim();
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
}

export interface KeyInput {
  isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode?: (raw: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}

export interface KeyOutput {
  write: (text: string) => unknown;
}

export function readMaskedLine(
  prompt: string,
  input: KeyInput = process.stdin,
  output: KeyOutput = process.stdout,
): Promise<string> {
  output.write(prompt);
  const wasRaw = input.isRaw ?? false;
  if (input.isTTY) input.setRawMode?.(true);
  input.resume();

  return new Promise((resolve) => {
    let entered = "";
    const finish = () => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      resolve(entered);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (enter.has(char)) return finish();
        if (char === interrupt) {
          entered = "";
          return finish();
        }
        if (erase.has(char)) {
          if (entered.length > 0) {
            entered = entered.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        entered += char;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
}

export async function updateUserConfig(
  mutate: (existing: KeyworkConfig) => KeyworkConfig,
  dir: string = join(homedir(), ".keywork"),
): Promise<string> {
  const file = join(dir, "keywork.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const merged = mutate(await readKnownConfig(file));
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export function saveApiKey(
  provider: string,
  key: string,
  dir: string = join(homedir(), ".keywork"),
): Promise<string> {
  return updateUserConfig(
    (existing) => ({ ...existing, apiKeys: { ...existing.apiKeys, [provider]: key } }),
    dir,
  );
}

function askLine(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return readline.question(prompt).finally(() => readline.close());
}

async function readKnownConfig(file: string): Promise<KeyworkConfig> {
  const raw = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (typeof raw !== "object" || raw === null) return {};
  const fields = raw as Record<string, unknown>;
  const known = Object.fromEntries(
    Object.keys(configSchema.shape)
      .filter((field) => field in fields)
      .map((field) => [field, fields[field]]),
  );
  const parsed = configSchema.safeParse(known);
  return parsed.success ? parsed.data : {};
}
