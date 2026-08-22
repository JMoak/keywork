import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ConnectionDraft, ConnectionsPort, ConnectionTarget } from "@keywork/tui";
import { saveCredential } from "./auth-store.ts";
import { loginWithBrowser, loginWithDeviceCode } from "./codex-login.ts";
import { codexProviderName } from "./inference/builtins.ts";

export { updateUserConfig } from "./user-config.ts";

export interface ConnectIo {
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  print(line: string): void;
}

export interface ConnectOptions {
  argument?: string | undefined;
  io?: ConnectIo | undefined;
  signIn?: ((method: "browser" | "device") => Promise<string>) | undefined;
}

const codexChoiceId = "chatgpt";

export async function connectCommand(
  port: ConnectionsPort,
  options: ConnectOptions = {},
): Promise<number> {
  const io = options.io ?? terminalIo();
  const chosen = await chooseTarget(port, options.argument, io);
  if (chosen === undefined) return 1;
  if (chosen === codexChoiceId) return signInToCodex(io, options.signIn);
  const draft = await completeDraft(port, chosen, io);
  if (draft === undefined) return 1;
  io.print(`\nverifying ${draft.endpoint}/models …`);
  const verification = await port.verify(draft);
  if (!verification.ok) {
    io.print(`not saved: ${verification.reason}`);
    return 1;
  }
  await port.save(draft, verification);
  io.print(
    `\nSaved ${draft.name} · ${describeModels(verification.models)} · verified ${verification.at}`,
  );
  io.print(`Try it:  keywork panes   then /model to pick ${draft.name}/<model>`);
  return 0;
}

export function saveApiKey(
  provider: string,
  key: string,
  dir: string = join(homedir(), ".keywork"),
): Promise<string> {
  return saveCredential(provider, { type: "api_key", key }, dir);
}

async function chooseTarget(
  port: ConnectionsPort,
  argument: string | undefined,
  io: ConnectIo,
): Promise<ConnectionDraft | typeof codexChoiceId | undefined> {
  if (argument !== undefined && argument !== "") return draftFromArgument(port, argument, io);
  const targets = port.targets();
  io.print("keywork connect: add an inference provider\n");
  for (const [index, target] of targets.entries()) {
    io.print(`  ${index + 1}. ${describeTarget(target)}`);
  }
  io.print(`  ${targets.length + 1}. OpenAI via ChatGPT Plus/Pro (subscription sign-in)`);
  printSaved(port, io);
  const answer = (await io.ask("\nChoice [1]: ")).trim() || "1";
  if (Number(answer) === targets.length + 1) return codexChoiceId;
  const target = targets[Number(answer) - 1];
  if (target === undefined) {
    io.print(`"${answer}" is not an option`);
    return undefined;
  }
  return port.draftFor(target);
}

function draftFromArgument(
  port: ConnectionsPort,
  argument: string,
  io: ConnectIo,
): ConnectionDraft | typeof codexChoiceId | undefined {
  if (argument === codexChoiceId || argument === codexProviderName) return codexChoiceId;
  const target = port.targets().find((candidate) => candidate.id === argument);
  if (target !== undefined) return port.draftFor(target);
  const saved = port.saved().find((row) => row.name === argument);
  if (saved !== undefined) return port.draftFor(saved);
  if (/^https?:\/\//.test(argument)) {
    const custom = port.targets().find((candidate) => candidate.kind === "custom");
    if (custom !== undefined)
      return { ...port.draftFor(custom), endpoint: argument.replace(/\/+$/, "") };
  }
  io.print(`"${argument}" is not a known target, a saved connection, or a URL`);
  return undefined;
}

async function completeDraft(
  port: ConnectionsPort,
  initial: ConnectionDraft,
  io: ConnectIo,
): Promise<ConnectionDraft | undefined> {
  const target = port
    .targets()
    .find((candidate) => candidate.name === initial.name && candidate.kind !== "custom");
  const nameEditable = target?.nameEditable ?? true;
  const endpointEditable = target?.endpointEditable ?? true;
  const name = nameEditable
    ? (await io.ask(`Name [${initial.name || "required"}]: `)).trim() || initial.name
    : initial.name;
  if (name === "") {
    io.print("a connection needs a name");
    return undefined;
  }
  const endpoint = endpointEditable
    ? (await io.ask(`Endpoint [${initial.endpoint || "required"}]: `)).trim() || initial.endpoint
    : initial.endpoint;
  if (endpoint === "") {
    io.print("a connection needs an endpoint URL");
    return undefined;
  }
  const keyPrompt =
    initial.credential === "none"
      ? "API key (blank for none): "
      : `${name} API key${target?.keyUrl === undefined ? "" : ` (get one: ${target.keyUrl})`}: `;
  const apiKey = (await io.askSecret(keyPrompt)).trim();
  const credential = apiKey !== "" ? "api-key" : initial.credential;
  return { ...initial, name, endpoint: endpoint.replace(/\/+$/, ""), apiKey, credential };
}

async function signInToCodex(
  io: ConnectIo,
  signIn: ConnectOptions["signIn"] = defaultCodexSignIn,
): Promise<number> {
  const method = (await io.ask("Sign in via [b]rowser or [d]evice code (for SSH)? [b]: "))
    .trim()
    .toLowerCase();
  try {
    const file = await signIn(method.startsWith("d") ? "device" : "browser");
    io.print(`\nSigned in. Credentials saved to ${file}`);
    io.print("Try it:  keywork panes");
    return 0;
  } catch (cause) {
    io.print(`sign-in failed: ${(cause as Error).message}`);
    return 1;
  }
}

async function defaultCodexSignIn(method: "browser" | "device"): Promise<string> {
  const credential = method === "device" ? await loginWithDeviceCode() : await loginWithBrowser();
  return saveCredential(codexProviderName, credential);
}

function printSaved(port: ConnectionsPort, io: ConnectIo): void {
  const saved = port.saved();
  if (saved.length === 0) return;
  io.print("\nconfigured:");
  for (const row of saved) {
    const facts = [
      row.credential,
      row.verifiedAt === undefined ? undefined : `verified ${row.verifiedAt}`,
    ]
      .filter((fact) => fact !== undefined)
      .join(" · ");
    io.print(`  ${row.name} · ${row.endpoint} · ${facts}`);
  }
}

function describeTarget(target: ConnectionTarget): string {
  switch (target.kind) {
    case "built-in":
      return `${target.label} (API key)`;
    case "local":
      return `${target.label} · ${target.endpoint}`;
    case "custom":
      return "Custom OpenAI-compatible endpoint (URL)";
  }
}

function describeModels(models: readonly string[]): string {
  if (models.length === 0) return "no models reported";
  const shown = models.slice(0, 4).join(", ");
  return models.length > 4
    ? `${models.length} models reported (${shown}, …)`
    : `models reported: ${shown}`;
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

const enter = new Set(["\r", "\n"]);
const erase = new Set([String.fromCharCode(127), "\b"]);
const interrupt = String.fromCharCode(3);

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

function terminalIo(): ConnectIo {
  return {
    ask: (prompt) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      return readline.question(prompt).finally(() => readline.close());
    },
    askSecret: (prompt) => readMaskedLine(prompt),
    print: (line) => console.log(line),
  };
}
