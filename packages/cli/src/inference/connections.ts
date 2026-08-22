import { type FetchLike, isLoopbackEndpoint } from "@keywork/engine";
import type { ConnectionConfig, KeyworkConfig } from "@keywork/shared";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  CredentialChoice,
  RemovalReceipt,
  SavedConnection,
} from "@keywork/tui";
import { type CredentialMap, deleteCredential, saveCredential } from "../auth-store.ts";
import { updateUserConfig } from "../user-config.ts";
import {
  type BuiltInProvider,
  builtInProvider,
  builtInProviders,
  localTemplates,
} from "./builtins.ts";
import { forgetObservation, type ObservationMap, recordObservation } from "./observations.ts";
import { verifyEndpoint } from "./verify.ts";

export interface ConnectionsDeps {
  env: Record<string, string | undefined>;
  userDir: string;
  config: () => KeyworkConfig;
  credentials: () => CredentialMap;
  observations: () => ObservationMap;
  changed: () => Promise<void>;
  fetchFn?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

export function connectionsPort(deps: ConnectionsDeps): ConnectionsPort {
  return {
    targets: () => [...builtInTargets(), ...localTargets(), customTarget],
    saved: () => savedRows(deps),
    draftFor: (target) =>
      "kind" in target ? draftFromTarget(target) : draftFromSaved(target, deps),
    verify: async (draft) => {
      const report = await verifyEndpoint({
        endpoint: draft.endpoint,
        headers: authHeadersFor(draft, deps),
        ...(deps.fetchFn !== undefined && { fetchFn: deps.fetchFn }),
        ...(deps.now !== undefined && { now: deps.now }),
      });
      if (!report.ok) await rememberFailure(draft.name, report, deps);
      return report;
    },
    save: async (draft, verification) => {
      await persistDraft(draft, deps);
      await recordObservation(
        draft.name,
        {
          verifiedAt: verification.at,
          modelsReportedAt: verification.at,
          models: verification.models,
          lastFailure: undefined,
        },
        deps.userDir,
      );
      await deps.changed();
    },
    remove: async (name) => {
      const receipt = await removeConnection(name, deps);
      await deps.changed();
      return receipt;
    },
  };
}

const customTarget: ConnectionTarget = {
  id: "custom",
  label: "Custom endpoint",
  kind: "custom",
  name: "",
  endpoint: "",
  protocol: "chat-completions",
  credential: "api-key",
  endpointEditable: true,
  nameEditable: true,
};

function builtInTargets(): ConnectionTarget[] {
  return builtInProviders.flatMap((provider) => {
    if (provider.auth.kind !== "api-key" || provider.protocol === "bedrock-converse") return [];
    return [
      {
        id: provider.name,
        label: provider.label,
        kind: "built-in" as const,
        name: provider.name,
        endpoint: provider.endpoint,
        protocol: provider.protocol,
        credential: "api-key" as const,
        endpointEditable: false,
        nameEditable: false,
        keyUrl: provider.auth.keyUrl,
      },
    ];
  });
}

function localTargets(): ConnectionTarget[] {
  return localTemplates.map((template) => ({
    id: template.name,
    label: template.label,
    kind: "local" as const,
    name: template.name,
    endpoint: template.endpoint,
    protocol: "chat-completions" as const,
    credential: "none" as const,
    endpointEditable: true,
    nameEditable: true,
  }));
}

function draftFromTarget(target: ConnectionTarget): ConnectionDraft {
  return {
    name: target.name,
    endpoint: target.endpoint,
    protocol: target.protocol,
    credential: target.credential,
    apiKey: "",
    insecureTransport: false,
  };
}

function draftFromSaved(saved: SavedConnection, deps: ConnectionsDeps): ConnectionDraft {
  const connection = deps.config().connections?.[saved.name];
  const builtIn = builtInProvider(saved.name);
  if (connection === undefined) {
    return {
      name: saved.name,
      endpoint: builtIn?.endpoint ?? saved.endpoint,
      protocol: saved.protocol === "responses" ? "responses" : "chat-completions",
      credential: "api-key",
      apiKey: "",
      insecureTransport: false,
    };
  }
  const source = connection.credential ?? defaultCredentialSource(connection.endpoint);
  return {
    name: saved.name,
    endpoint: connection.endpoint,
    protocol: connection.protocol ?? "chat-completions",
    credential: credentialChoiceOf(source),
    apiKey: "",
    insecureTransport: connection.insecureTransport ?? false,
  };
}

function credentialChoiceOf(source: string): CredentialChoice {
  if (source === "saved") return "api-key";
  if (source === "none") return "none";
  return `env:${source.slice("env:".length)}`;
}

function savedRows(deps: ConnectionsDeps): SavedConnection[] {
  const config = deps.config();
  const credentials = deps.credentials();
  const observations = deps.observations();
  const connections = Object.entries(config.connections ?? {}).map(([name, connection]) =>
    connectionRow(name, connection, credentials, observations[name]),
  );
  const builtIns = builtInProviders.flatMap((provider) => {
    const credential = builtInCredentialLabel(provider, credentials, deps.env);
    return credential === undefined
      ? []
      : [builtInRow(provider, credential, observations[provider.name])];
  });
  return [...builtIns, ...connections];
}

function connectionRow(
  name: string,
  connection: ConnectionConfig,
  credentials: CredentialMap,
  observation: ObservationMap[string] | undefined,
): SavedConnection {
  const source = connection.credential ?? defaultCredentialSource(connection.endpoint);
  const credential =
    source === "none"
      ? "no credential"
      : source === "saved"
        ? credentials[name]?.type === "api_key"
          ? "saved key"
          : "saved key missing"
        : source;
  return {
    name,
    endpoint: connection.endpoint,
    protocol: connection.protocol ?? "chat-completions",
    credential,
    builtIn: false,
    enabled: connection.enabled ?? true,
    ...observationFacts(observation),
  };
}

function builtInRow(
  provider: BuiltInProvider,
  credential: string,
  observation: ObservationMap[string] | undefined,
): SavedConnection {
  return {
    name: provider.name,
    endpoint: provider.endpoint,
    protocol: provider.protocol,
    credential,
    builtIn: true,
    enabled: true,
    ...observationFacts(observation),
  };
}

function builtInCredentialLabel(
  provider: BuiltInProvider,
  credentials: CredentialMap,
  env: Record<string, string | undefined>,
): string | undefined {
  const saved = credentials[provider.name];
  switch (provider.auth.kind) {
    case "api-key": {
      const { scopedVariable, ambientVariable } = provider.auth;
      if (presentIn(env, scopedVariable)) return scopedVariable;
      if (saved?.type === "api_key") return "saved key";
      if (presentIn(env, ambientVariable)) return ambientVariable;
      return undefined;
    }
    case "oauth":
      return saved?.type === "oauth" ? "ChatGPT sign-in" : undefined;
    case "aws-sigv4":
      return presentIn(env, "AWS_ACCESS_KEY_ID") ? "AWS environment" : undefined;
  }
}

function observationFacts(
  observation: ObservationMap[string] | undefined,
): Pick<SavedConnection, "verifiedAt" | "modelsReportedAt" | "modelCount" | "lastFailure"> {
  if (observation === undefined) return {};
  return {
    ...(observation.verifiedAt !== undefined && { verifiedAt: observation.verifiedAt }),
    ...(observation.modelsReportedAt !== undefined && {
      modelsReportedAt: observation.modelsReportedAt,
    }),
    ...(observation.models !== undefined && { modelCount: observation.models.length }),
    ...(observation.lastFailure !== undefined && { lastFailure: observation.lastFailure }),
  };
}

function authHeadersFor(draft: ConnectionDraft, deps: ConnectionsDeps): Record<string, string> {
  const key = apiKeyFor(draft, deps);
  return key === undefined ? {} : { authorization: `Bearer ${key}` };
}

function apiKeyFor(draft: ConnectionDraft, deps: ConnectionsDeps): string | undefined {
  if (draft.credential === "none") return undefined;
  if (draft.credential === "api-key") {
    if (draft.apiKey !== "") return draft.apiKey;
    const saved = deps.credentials()[draft.name];
    return saved?.type === "api_key" ? saved.key : undefined;
  }
  return deps.env[draft.credential.slice("env:".length)];
}

async function persistDraft(draft: ConnectionDraft, deps: ConnectionsDeps): Promise<void> {
  if (draft.credential === "api-key" && draft.apiKey !== "") {
    await saveCredential(draft.name, { type: "api_key", key: draft.apiKey }, deps.userDir);
  }
  if (builtInProvider(draft.name) !== undefined) return;
  await updateUserConfig(
    (existing) => ({
      ...existing,
      connections: {
        ...existing.connections,
        [draft.name]: connectionConfigOf(draft, existing.connections?.[draft.name]),
      },
    }),
    deps.userDir,
  );
}

function connectionConfigOf(
  draft: ConnectionDraft,
  existing: ConnectionConfig | undefined,
): ConnectionConfig {
  const source = draft.credential === "api-key" ? "saved" : draft.credential;
  return {
    endpoint: draft.endpoint,
    ...(draft.protocol !== "chat-completions" && { protocol: draft.protocol }),
    ...(source !== defaultCredentialSource(draft.endpoint) && { credential: source }),
    ...(draft.insecureTransport && { insecureTransport: true }),
    ...fieldsOutsideTheDraft(existing),
  };
}

function fieldsOutsideTheDraft(
  existing: ConnectionConfig | undefined,
): Pick<ConnectionConfig, "models" | "enabled"> {
  return {
    ...(existing?.models !== undefined && { models: existing.models }),
    ...(existing?.enabled !== undefined && { enabled: existing.enabled }),
  };
}

async function rememberFailure(
  name: string,
  failure: { at: string; reason: string },
  deps: ConnectionsDeps,
): Promise<void> {
  if (!savedRows(deps).some((row) => row.name === name)) return;
  await recordObservation(
    name,
    { lastFailure: { at: failure.at, reason: failure.reason } },
    deps.userDir,
  );
  await deps.changed();
}

async function removeConnection(name: string, deps: ConnectionsDeps): Promise<RemovalReceipt> {
  const removed: string[] = [];
  const retained: string[] = [];
  const config = deps.config();
  if (config.connections?.[name] !== undefined) {
    await updateUserConfig((existing) => {
      const { [name]: _gone, ...rest } = existing.connections ?? {};
      return { ...existing, connections: rest };
    }, deps.userDir);
    removed.push(`connection ${name}`);
  }
  const saved = deps.credentials()[name];
  if (saved !== undefined) {
    await deleteCredential(name, deps.userDir);
    removed.push(saved.type === "oauth" ? `sign-in for ${name}` : `saved key for ${name}`);
  }
  const envSource = envCredentialSource(name, deps);
  if (envSource !== undefined)
    retained.push(`${envSource} (environment variables are never deleted)`);
  await forgetObservation(name, deps.userDir);
  return { removed, retained };
}

function envCredentialSource(name: string, deps: ConnectionsDeps): string | undefined {
  const builtIn = builtInProvider(name);
  if (builtIn?.auth.kind === "api-key") {
    return [builtIn.auth.scopedVariable, builtIn.auth.ambientVariable].find((variable) =>
      presentIn(deps.env, variable),
    );
  }
  const source = deps.config().connections?.[name]?.credential;
  return source?.startsWith("env:") ? source.slice("env:".length) : undefined;
}

function defaultCredentialSource(endpoint: string): "none" | "saved" {
  return isLoopbackEndpoint(endpoint) ? "none" : "saved";
}

function presentIn(env: Record<string, string | undefined>, variable: string): boolean {
  const value = env[variable];
  return value !== undefined && value !== "";
}
