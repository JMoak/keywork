import { homedir } from "node:os";
import { join } from "node:path";
import { connectionDraftProblem } from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { ConnectionDraft, ConnectionsPort, ConnectionTarget } from "@keywork/tui";
import { saveCredential } from "./auth-store.ts";
import { loginWithBrowser, loginWithDeviceCode } from "./codex-login.ts";
import { codexProviderName } from "./inference/builtins.ts";
import { type DeciderConnection, typesafeTerms } from "./inference/typesafe-connection.ts";
import type { FirstModelSetup } from "./setup-model.ts";
import { processStreams, type TerminalStreams, terminalInput } from "./terminal-input.ts";

export { firstModelSetupFor } from "./setup-model.ts";

export interface ConnectIo {
  ask(prompt: string): Promise<string | undefined>;
  askSecret(prompt: string): Promise<string | undefined>;
  print(line: string): void;
  close?(): void;
}

export interface ConnectOptions {
  argument?: string | undefined;
  group?: ConnectionGroup | undefined;
  firstModel?: FirstModelSetup | undefined;
  io?: ConnectIo | undefined;
  signIn?: ((method: "browser" | "device") => Promise<string>) | undefined;
  decider?: DeciderConnection | undefined;
}

const connectionGroups = ["local", "flagship", "openrouter"] as const;
export type ConnectionGroup = (typeof connectionGroups)[number];

export function connectionGroupOf(value: string | undefined): ConnectionGroup | undefined {
  return connectionGroups.find((group) => group === value);
}

const codexChoiceId = "chatgpt";
const existingModelChoice = "existing-model";

type Choice =
  | ConnectionDraft
  | typeof codexChoiceId
  | typeof existingModelChoice
  | DeciderConnection;

export async function connectCommand(
  port: ConnectionsPort,
  options: ConnectOptions = {},
): Promise<number> {
  const io = options.io ?? terminalConnectIo();
  try {
    return await connect(port, options, io);
  } catch (error) {
    if (!(error instanceof ConnectCancelled)) throw error;
    io.print("Model setup cancelled.");
    return 130;
  } finally {
    io.close?.();
  }
}

export function terminalConnectIo(streams: TerminalStreams = processStreams()): ConnectIo {
  const terminal = terminalInput(streams);
  return {
    ask: (prompt) => terminal.readLine(prompt),
    askSecret: (prompt) => terminal.readSecretOrCancel(prompt),
    print: (line) => console.log(line),
    close: () => terminal.close(),
  };
}

export function saveApiKey(
  provider: string,
  key: string,
  dir: string = join(homedir(), ".keywork"),
): Promise<string> {
  return saveCredential(provider, { type: "api_key", key }, dir);
}

async function connect(
  port: ConnectionsPort,
  options: ConnectOptions,
  io: ConnectIo,
): Promise<number> {
  const { argument, group, firstModel } = options;
  if (argument === undefined && group === undefined && firstModel !== undefined) {
    const standing = firstModel.standing();
    if (standing.kind === "available") return chooseFirstModel(firstModel, undefined, io);
  }
  const chosen = await chooseTarget(port, options, io);
  if (chosen === undefined) return 1;
  if (chosen === existingModelChoice) return chooseFirstModel(firstModel, undefined, io);
  if (chosen === codexChoiceId) {
    const signedIn = await signInToCodex(io, options.signIn);
    if (signedIn !== 0) return signedIn;
    await firstModel?.refresh();
    return chooseFirstModel(firstModel, codexProviderName, io);
  }
  if ("target" in chosen) return connectDecider(chosen, io);
  const guided = group !== undefined || firstModel !== undefined;
  let draft = await completeDraft(port, chosen, io, guided);
  while (draft !== undefined) {
    io.print(`\nverifying ${draft.endpoint}/models …`);
    const verification = await port.verify(draft);
    if (verification.ok) {
      await port.save(draft, verification);
      const observation = guided ? "model list checked" : "verified";
      io.print(
        `\nSaved ${draft.name} · ${describeModels(verification.models)} · ${observation} ${verification.at}`,
      );
      if (firstModel !== undefined) return chooseFirstModel(firstModel, draft.name, io);
      io.print(`Try it:  keywork panes   then /model to pick ${draft.name}/<model>`);
      return 0;
    }
    io.print(`not saved: ${verification.reason}`);
    if (!guided || !(await confirmed(io, "Edit the connection and try again? [y/N]: "))) return 1;
    draft = await completeDraft(port, draft, io, guided);
  }
  return 1;
}

async function chooseTarget(
  port: ConnectionsPort,
  { argument, group, firstModel, decider }: ConnectOptions,
  io: ConnectIo,
): Promise<Choice | undefined> {
  if (argument !== undefined && argument !== "")
    return choiceFromArgument(port, argument, decider, io);
  if (group !== undefined) return chooseGroupTarget(port, group, io);
  if (firstModel !== undefined) {
    const selected = await chooseGroup(firstModel, io);
    if (selected === existingModelChoice || selected === undefined) return selected;
    return chooseGroupTarget(port, selected, io);
  }
  const targets = port.targets();
  io.print("keywork connect: add an inference provider\n");
  for (const [index, target] of targets.entries()) {
    io.print(`  ${index + 1}. ${describeTarget(target)}`);
  }
  io.print(`  ${targets.length + 1}. OpenAI via ChatGPT Plus/Pro (subscription sign-in)`);
  if (decider !== undefined) {
    io.print("\nmemory decisions:");
    io.print(`  ${targets.length + 2}. ${decider.target.label}`);
  }
  printSaved(port, io);
  const answer = (await answerFrom(io.ask("\nChoice [1]: "))) || "1";
  if (Number(answer) === targets.length + 1) return codexChoiceId;
  if (decider !== undefined && Number(answer) === targets.length + 2) return decider;
  const target = targets[Number(answer) - 1];
  if (target === undefined) {
    io.print(`"${answer}" is not an option`);
    return undefined;
  }
  return port.draftFor(target);
}

const groupLabels: Readonly<Record<ConnectionGroup, string>> = {
  local: "Local",
  flagship: "Flagship AI direct",
  openrouter: "OpenRouter",
};

async function chooseGroup(firstModel: FirstModelSetup, io: ConnectIo) {
  io.print("Choose how to connect your model.");
  const choices = connectionGroups.map((group) => ({ value: group, label: groupLabels[group] }));
  return pick<ConnectionGroup | typeof existingModelChoice>(
    firstModel.choices().length === 0
      ? choices
      : [...choices, { value: existingModelChoice, label: "Use an already connected provider" }],
    io,
  );
}

async function chooseGroupTarget(
  port: ConnectionsPort,
  group: ConnectionGroup,
  io: ConnectIo,
): Promise<ConnectionDraft | undefined> {
  const targets = port.targets();
  if (group === "openrouter") {
    const target = targets.find(({ id }) => id === "openrouter");
    return target === undefined ? undefined : port.draftFor(target);
  }
  if (group === "flagship") {
    io.print("Connect directly using a provider API key.");
    const target = await pick(
      targets
        .filter(({ id }) => id === "openai" || id === "anthropic")
        .map((value) => ({ value, label: value.label })),
      io,
    );
    return target === undefined ? undefined : port.draftFor(target);
  }
  return chooseLocalTarget(port, targets, io);
}

async function chooseLocalTarget(
  port: ConnectionsPort,
  targets: readonly ConnectionTarget[],
  io: ConnectIo,
): Promise<ConnectionDraft | undefined> {
  io.print("Start the local model server before connecting it.");
  const found = await findLocal(port, io);
  if (found.length === 0) localSetupHelp(io);
  const observed = new Set(found.map(({ target }) => target.id));
  const choices = [
    ...found.map(({ target, models }) => ({
      value: target,
      label: `${target.label} · ${describeModels(models)}`,
    })),
    ...targets
      .filter(({ kind, id }) => (kind === "local" || kind === "custom") && !observed.has(id))
      .map((value) => ({ value, label: describeTarget(value) })),
  ];
  const target = await pick(choices, io);
  if (target === undefined) return undefined;
  const draft = port.draftFor(target);
  return target.kind === "custom" ? { ...draft, credential: "none" } : draft;
}

async function findLocal(port: ConnectionsPort, io: ConnectIo) {
  if (port.findLocal === undefined || !(await confirmed(io, "Look for local models now? [y/N]: ")))
    return [];
  io.print("Checking known local endpoints…");
  const found = await port.findLocal();
  if (found.length === 0) io.print("No model lists found. You can enter an endpoint below.");
  return found;
}

function localSetupHelp(io: ConnectIo): void {
  io.print(
    "LM Studio · Install and open the app, download a chat model, then load it and start the server in Developer.",
  );
  io.print("  https://lmstudio.ai/docs/developer/rest/quickstart");
  io.print(
    "Ollama · Install and open Ollama, then download a local model with the app or `ollama pull <model>`. Keep Ollama running.",
  );
  io.print("  https://docs.ollama.com/quickstart");
}

const shownModelLimit = 12;

async function chooseFirstModel(
  setup: FirstModelSetup | undefined,
  provider: string | undefined,
  io: ConnectIo,
): Promise<number> {
  if (setup === undefined) return 0;
  const standing = setup.standing();
  if (standing.kind === "available") {
    if (
      standing.configured === undefined &&
      (provider === undefined || standing.reference.startsWith(`${provider}/`))
    ) {
      return confirmFirstModel(setup, standing.reference, undefined, io);
    }
    io.print(`Starting model: ${standing.reference}`);
    if (provider === undefined) return 0;
  } else {
    io.print(standing.reason);
    if (standing.configured !== undefined)
      io.print(`Current starting model: ${standing.configured}`);
  }
  const visible = setup.choices(provider).slice(0, shownModelLimit);
  for (const [index, reference] of visible.entries()) io.print(`  ${index + 1}. ${reference}`);
  for (;;) {
    const answer = await answerFrom(io.ask("Model [number or model ID, Enter for later]: "));
    if (answer === "") {
      io.print("Starting model unchanged.");
      return 0;
    }
    const reference = modelReferenceFrom(answer, visible, provider);
    if (reference === undefined) {
      io.print(`"${answer}" is not an option.`);
      continue;
    }
    const problem = setup.check(reference);
    if (problem !== undefined) {
      io.print(problem);
      continue;
    }
    return confirmFirstModel(setup, reference, standing.configured, io);
  }
}

function modelReferenceFrom(
  answer: string,
  visible: readonly string[],
  provider: string | undefined,
): string | undefined {
  if (/^\d+$/.test(answer)) return visible[Number(answer) - 1];
  return provider === undefined || answer.startsWith(`${provider}/`)
    ? answer
    : `${provider}/${answer}`;
}

async function confirmFirstModel(
  setup: FirstModelSetup,
  reference: string,
  previous: string | undefined,
  io: ConnectIo,
): Promise<number> {
  io.print(`Selected ${reference} for this setup.`);
  if (!(await confirmed(io, "Use this as the starting model for new conversations? [y/N]: "))) {
    io.print("Starting model unchanged.");
    return 0;
  }
  const problem = await setup.remember(reference, previous);
  if (problem !== undefined) {
    io.print(`Starting model unchanged. ${problem}`);
    return 1;
  }
  io.print(`Starting model saved: ${reference}. Send a message to see it answer.`);
  return 0;
}

async function pick<T>(
  choices: readonly { value: T; label: string }[],
  io: ConnectIo,
): Promise<T | undefined> {
  if (choices.length === 0) return undefined;
  for (const [index, { label }] of choices.entries()) io.print(`  ${index + 1}. ${label}`);
  for (;;) {
    const answer = await answerFrom(io.ask("Choice [Enter cancels]: "));
    if (answer === "") throw new ConnectCancelled();
    const chosen = choices[Number(answer) - 1];
    if (chosen !== undefined) return chosen.value;
    io.print(`"${answer}" is not an option.`);
  }
}

async function confirmed(io: ConnectIo, question: string): Promise<boolean> {
  const answer = (await answerFrom(io.ask(question))).toLowerCase();
  return answer === "y" || answer === "yes";
}

class ConnectCancelled extends Error {}

async function answerFrom(answer: Promise<string | undefined>): Promise<string> {
  const read = await answer;
  if (read === undefined) throw new ConnectCancelled();
  return read.trim();
}

function choiceFromArgument(
  port: ConnectionsPort,
  argument: string,
  decider: DeciderConnection | undefined,
  io: ConnectIo,
): Choice | undefined {
  if (argument === codexChoiceId || argument === codexProviderName) return codexChoiceId;
  if (decider !== undefined && argument === decider.target.name) return decider;
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
  guided: boolean,
): Promise<ConnectionDraft | undefined> {
  const target = port
    .targets()
    .find((candidate) => candidate.name === initial.name && candidate.kind !== "custom");
  let draft = { ...initial, apiKey: "" };
  for (;;) {
    draft = await editDraft(draft, target, io);
    const problem =
      draft.endpoint === "" && draft.name !== ""
        ? "a connection needs an endpoint URL"
        : connectionDraftProblem(draft);
    if (problem === undefined) return askKey(draft, target, io);
    io.print(guided ? `not saved: ${problem}` : problem);
    if (!guided || !(await confirmed(io, "Edit the connection and try again? [y/N]: ")))
      return undefined;
  }
}

async function editDraft(
  draft: ConnectionDraft,
  target: ConnectionTarget | undefined,
  io: ConnectIo,
): Promise<ConnectionDraft> {
  const field = async (label: string, held: string, editable = true): Promise<string> =>
    editable ? (await answerFrom(io.ask(`${label} [${held || "required"}]: `))) || held : held;
  const name = await field("Name", draft.name, target?.nameEditable);
  if (name === "") return { ...draft, name };
  const endpoint = await field("Endpoint", draft.endpoint, target?.endpointEditable);
  return { ...draft, name, endpoint: endpoint.replace(/\/+$/, "") };
}

async function askKey(
  draft: ConnectionDraft,
  target: ConnectionTarget | undefined,
  io: ConnectIo,
): Promise<ConnectionDraft> {
  const keyPrompt =
    draft.credential === "none"
      ? "API key (blank for none): "
      : `${draft.name} API key${target?.keyUrl === undefined ? "" : ` (get one: ${target.keyUrl})`}: `;
  const apiKey = await answerFrom(io.askSecret(keyPrompt));
  const credential = apiKey !== "" ? "api-key" : draft.credential;
  return { ...draft, apiKey, credential };
}

async function signInToCodex(
  io: ConnectIo,
  signIn: ConnectOptions["signIn"] = defaultCodexSignIn,
): Promise<number> {
  const method = (
    await answerFrom(io.ask("Sign in via [b]rowser or [d]evice code (for SSH)? [b]: "))
  ).toLowerCase();
  try {
    const file = await signIn(method.startsWith("d") ? "device" : "browser");
    io.print(`\nSigned in. Credentials saved to ${file}`);
    io.print("Try it:  keywork panes");
    return 0;
  } catch (cause) {
    io.print(`sign-in failed: ${toError(cause).message}`);
    return 1;
  }
}

async function defaultCodexSignIn(method: "browser" | "device"): Promise<string> {
  const credential = method === "device" ? await loginWithDeviceCode() : await loginWithBrowser();
  return saveCredential(codexProviderName, credential);
}

async function connectDecider(decider: DeciderConnection, io: ConnectIo): Promise<number> {
  const { target } = decider;
  io.print(`keywork connect ${target.name}: ${target.label}`);
  io.print(typesafeTerms);
  const key = await answerFrom(
    io.askSecret(`\n${target.name} API key (get one: ${target.auth.keyUrl}): `),
  );
  if (key === "") {
    io.print(`not saved: ${target.name} needs an API key`);
    return 1;
  }
  io.print(`\nverifying ${target.endpoint}/models …`);
  const verification = await decider.verify(key);
  if (!verification.ok) {
    io.print(`not saved: ${verification.reason}`);
    return 1;
  }
  await decider.save(key, verification);
  io.print(
    `\nSaved ${target.name} · ${describeModels(verification.models)} · verified ${verification.at}`,
  );
  if (!verification.models.includes(target.defaultModel)) {
    io.print(
      `TypeSafe's list does not name ${target.defaultModel} · keywork asks for it by version and checks the model behind every answer`,
    );
  }
  return offerJev(decider, io);
}

async function offerJev(decider: DeciderConnection, io: ConnectIo): Promise<number> {
  if (decider.selected() === "jev") {
    io.print(`memory decider: jev, already set in ${decider.configFile}`);
    return 0;
  }
  const answer = (
    await answerFrom(io.ask("use Jev for memory decisions now? [Y/n] "))
  ).toLowerCase();
  if (answer !== "" && !answer.startsWith("y")) {
    io.print(
      `memory decider stays builtin · "memory": { "decider": "jev" } in ${decider.configFile} turns Jev on`,
    );
    return 0;
  }
  io.print(`wrote "memory": { "decider": "jev" } to ${await decider.select()}`);
  return 0;
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
