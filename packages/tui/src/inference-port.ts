export type ConnectionProtocol = "chat-completions" | "responses";

export interface ModelChoice {
  reference: string;
  provider: string;
  model: string;
  available: boolean;
  facts: readonly string[];
}

export interface ResolutionNotice {
  ok: boolean;
  code?: string;
  message: string;
  nextAction?: string;
}

export interface InferencePort {
  choices(): readonly ModelChoice[];
  describe(reference: string): ResolutionNotice;
}

export type CredentialChoice = "none" | "api-key" | `env:${string}`;

export interface ConnectionTarget {
  id: string;
  label: string;
  kind: "built-in" | "local" | "custom";
  name: string;
  endpoint: string;
  protocol: ConnectionProtocol;
  credential: CredentialChoice;
  endpointEditable: boolean;
  nameEditable: boolean;
  keyUrl?: string;
}

export interface ConnectionDraft {
  name: string;
  endpoint: string;
  protocol: ConnectionProtocol;
  credential: CredentialChoice;
  apiKey: string;
  insecureTransport: boolean;
}

export type VerificationOutcome =
  | { ok: true; at: string; models: readonly string[] }
  | { ok: false; at: string; reason: string };

export interface SavedConnection {
  name: string;
  endpoint: string;
  protocol: string;
  credential: string;
  builtIn: boolean;
  enabled: boolean;
  verifiedAt?: string;
  modelsReportedAt?: string;
  modelCount?: number;
  lastFailure?: { at: string; reason: string };
}

export interface RemovalReceipt {
  removed: readonly string[];
  retained: readonly string[];
}

export interface ConnectionsPort {
  targets(): readonly ConnectionTarget[];
  saved(): readonly SavedConnection[];
  draftFor(target: ConnectionTarget | SavedConnection): ConnectionDraft;
  verify(draft: ConnectionDraft): Promise<VerificationOutcome>;
  save(draft: ConnectionDraft, verification: VerificationOutcome & { ok: true }): Promise<void>;
  remove(name: string): Promise<RemovalReceipt>;
}
