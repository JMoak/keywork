import { join } from "node:path";
import { type KeyworkConfig, loadConfig } from "@keywork/shared";
import type { ConnectionsPort } from "@keywork/tui";
import {
  type CredentialMap,
  legacyCredentials,
  readCredentials,
  saveCredential,
} from "./auth-store.ts";
import { connectionsPort } from "./inference/connections.ts";
import { type ObservationMap, readObservations } from "./inference/observations.ts";
import { composeInference, type InferenceRuntime } from "./inference/runtime.ts";
import { userConfigDir } from "./user-config.ts";

export interface InferenceState {
  config: KeyworkConfig;
  credentials: CredentialMap;
  observations: ObservationMap;
  runtime: InferenceRuntime;
}

export interface LiveInference {
  current(): InferenceState;
  reload(): Promise<void>;
  readonly connections: ConnectionsPort;
}

export interface InferenceStateOptions {
  cwd: string;
  projectTrusted: boolean;
  env: NodeJS.ProcessEnv;
  warn(line: string): void;
  compose?: typeof composeInference;
}

export async function openInferenceState(options: InferenceStateOptions): Promise<LiveInference> {
  let state = await loadInferenceState(options);
  const reload = async (): Promise<void> => {
    state = await loadInferenceState(options);
  };
  return {
    current: () => state,
    reload,
    connections: connectionsPort({
      env: options.env,
      userDir: userConfigDir(),
      config: () => state.config,
      credentials: () => state.credentials,
      observations: () => state.observations,
      changed: reload,
    }),
  };
}

async function loadInferenceState(options: InferenceStateOptions): Promise<InferenceState> {
  const config = await loadConfig({
    userDir: userConfigDir(),
    projectDir: join(options.cwd, ".keywork"),
    projectTrusted: options.projectTrusted,
  });
  const credentials = { ...legacyCredentials(config.apiKeys), ...(await readCredentials()) };
  const observations = await readObservations();
  const runtime = (options.compose ?? composeInference)({
    env: options.env,
    config,
    credentials,
    observations,
    persistCredential: (provider, credential) =>
      saveCredential(provider, credential).then(() => {}),
  });
  for (const warning of runtime.warnings) options.warn(`keywork: ${warning}`);
  return { config, credentials, observations, runtime };
}
