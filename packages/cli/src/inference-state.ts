import { join } from "node:path";
import { type KeyworkConfig, loadConfig } from "@keywork/shared";
import type { ConnectionsPort } from "@keywork/tui";
import {
  type CredentialMap,
  credentialPlacement,
  defaultAuthDir,
  legacyCredentials,
  readCredentials,
  type SecretKeeping,
  saveCredential,
  secretKeepingFor,
} from "./auth-store.ts";
import { typesafeDecider } from "./inference/builtins.ts";
import { connectionsPort } from "./inference/connections.ts";
import {
  type ObservationMap,
  readObservations,
  recordObservation,
} from "./inference/observations.ts";
import { composeInference, type InferenceRuntime } from "./inference/runtime.ts";
import { type DeciderConnection, typesafeConnection } from "./inference/typesafe-connection.ts";
import { type MemoryDeciderSetup, memoryDeciderSetup, typesafeRefusal } from "./memory-decider.ts";
import { userConfigDir } from "./user-config.ts";

export interface InferenceState {
  config: KeyworkConfig;
  credentials: CredentialMap;
  secrets?: SecretKeeping | undefined;
  observations: ObservationMap;
  runtime: InferenceRuntime;
  memoryDecider: MemoryDeciderSetup;
}

export interface LiveInference {
  current(): InferenceState;
  reload(): Promise<void>;
  readonly connections: ConnectionsPort;
  readonly decider: DeciderConnection;
}

export interface InferenceStateOptions {
  cwd: string;
  projectTrusted: boolean;
  env: NodeJS.ProcessEnv;
  warn(line: string): void;
  compose?: typeof composeInference;
}

export async function openInferenceState(options: InferenceStateOptions): Promise<LiveInference> {
  const noticeOnce = oncePerLine(options.warn);
  let state = await loadInferenceState(options, noticeOnce);
  const reload = async (): Promise<void> => {
    state = await loadInferenceState(options, noticeOnce);
  };
  return {
    current: () => state,
    reload,
    connections: connectionsPort({
      env: options.env,
      userDir: userConfigDir(),
      config: () => state.config,
      credentials: () => state.credentials,
      secrets: () => state.secrets,
      observations: () => state.observations,
      changed: reload,
    }),
    decider: typesafeConnection({
      userDir: userConfigDir(),
      config: () => state.config,
      secrets: () => state.secrets,
      changed: reload,
    }),
  };
}

async function loadInferenceState(
  options: InferenceStateOptions,
  noticeOnce: (line: string) => void,
): Promise<InferenceState> {
  const config = await loadConfig({
    userDir: userConfigDir(),
    projectDir: join(options.cwd, ".keywork"),
    projectTrusted: options.projectTrusted,
  });
  const secrets = secretKeepingFor(config, options.warn);
  const credentials = {
    ...legacyCredentials(config.apiKeys),
    ...(await readCredentials(defaultAuthDir(), secrets)),
  };
  const observations = await readObservations();
  const runtime = (options.compose ?? composeInference)({
    env: options.env,
    config,
    credentials,
    observations,
    persistCredential: (provider, credential) =>
      saveCredential(provider, credential, defaultAuthDir(), secrets).then(() => {}),
  });
  for (const warning of runtime.warnings) options.warn(`keywork: ${warning}`);
  const memoryDecider = memoryDeciderSetup({
    config,
    credentials,
    env: options.env,
    observations,
    placement: credentialPlacement(typesafeDecider.name),
    notice: noticeOnce,
    onRefused: rememberRefusal,
  });
  return { config, credentials, secrets, observations, runtime, memoryDecider };
}

function rememberRefusal(at: string): void {
  recordObservation(typesafeDecider.name, { lastFailure: { at, reason: typesafeRefusal } }).catch(
    () => undefined,
  );
}

function oncePerLine(print: (line: string) => void): (line: string) => void {
  const said = new Set<string>();
  return (line) => {
    if (said.has(line)) return;
    said.add(line);
    print(line);
  };
}
