import type { EgressRule } from "./egress.ts";

export type BrokerKind = "model-provider";

export interface CredentialBroker {
  readonly name: string;
  readonly kind: BrokerKind;
  readonly env: string;
  readonly hosts: readonly string[];
  reveal(): Promise<string | undefined>;
}

export type SecretSource = (name: string) => Promise<string | undefined>;

export const brokerSentinel = "proxy-managed";

export const modelProviderNames = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "groq",
  "mistral",
  "xai",
] as const;

export type ModelProviderName = (typeof modelProviderNames)[number];

interface ProviderCredential {
  readonly env: string;
  readonly hosts: readonly string[];
}

const providerCredentials: Readonly<Record<ModelProviderName, ProviderCredential>> = {
  anthropic: { env: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  openai: { env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  openrouter: { env: "OPENROUTER_API_KEY", hosts: ["openrouter.ai"] },
  google: { env: "GEMINI_API_KEY", hosts: ["generativelanguage.googleapis.com"] },
  groq: { env: "GROQ_API_KEY", hosts: ["api.groq.com"] },
  mistral: { env: "MISTRAL_API_KEY", hosts: ["api.mistral.ai"] },
  xai: { env: "XAI_API_KEY", hosts: ["api.x.ai"] },
};

export function modelProviderBrokers(
  secrets: SecretSource = environmentSecrets(),
): CredentialBroker[] {
  return modelProviderNames.map((name) => {
    const credential = providerCredentials[name];
    return { name, kind: "model-provider", ...credential, reveal: () => secrets(credential.env) };
  });
}

export function brokerHosts(names: readonly string[]): string[] {
  return modelProviderNames
    .filter((name) => names.includes(name))
    .flatMap((name) => providerCredentials[name].hosts);
}

export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return async (name) => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
}

export function sentinelEnvironment(brokers: readonly CredentialBroker[]): Record<string, string> {
  return Object.fromEntries(brokers.map((broker) => [broker.env, brokerSentinel]));
}

export function brokerEgress(brokers: readonly CredentialBroker[]): EgressRule[] {
  return brokers.flatMap((broker) =>
    broker.hosts.map((host) => ({ host, methods: "any" as const })),
  );
}

export function brokersNamed(
  brokers: readonly CredentialBroker[],
  names: readonly string[],
): CredentialBroker[] {
  return brokers.filter((broker) => names.includes(broker.name));
}
