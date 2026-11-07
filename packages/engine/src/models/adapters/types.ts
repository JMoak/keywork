import type { Provider } from "../../provider.ts";
import type { AuthHeaders, FetchLike } from "../../providers/transport.ts";
import type {
  CapabilityRecord,
  ImageInputKind,
  ServerFingerprint,
  ServerKind,
  ToolChoiceMode,
} from "../capabilities/types.ts";
import type { HealthReading } from "../health/types.ts";
import type { NormalizedUsage, UsageShape } from "../ledger/types.ts";
import type { ProbeHttp } from "./http.ts";

export interface ServerDeltas {
  kind: ServerKind;
  defaultPort: number;
  versionTested: string;
  droppedChatFields: readonly string[];
  honoredToolChoice: readonly ToolChoiceMode[] | null;
  imageInput: ImageInputKind;
  reasoningDeltaFields: readonly string[];
  saturationStatuses: readonly number[];
  usageShape: UsageShape;
  rules: Readonly<Record<string, string>>;
}

export interface InstalledModel {
  id: string;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

export type LoadState = "loaded" | "loading" | "sleeping" | "unloaded";

export interface LoadedModel {
  id: string;
  state: LoadState;
  contextAllocated: number | null;
  memoryBytes: number | null;
  expiresAt: string | null;
}

export interface ServerInventory {
  installed: readonly InstalledModel[];
  loaded: readonly LoadedModel[];
}

export interface ServerProbe {
  http: ProbeHttp;
  root: string;
  now(): Date;
}

export type ToolChoice =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "required" }
  | { mode: "named"; name: string };

export interface FieldMemory {
  rejects(field: string): boolean;
  reject(field: string, status: number): void;
}

export interface TurnUsageReport {
  usage: NormalizedUsage | null;
  servedModel: string | null;
}

export interface ChatOptions {
  name: string;
  root: string;
  model: string;
  authHeaders?: AuthHeaders | undefined;
  fetchFn?: FetchLike | undefined;
  toolChoice?: ToolChoice | undefined;
  optionalFields?: Readonly<Record<string, unknown>> | undefined;
  replayReasoning?: boolean | undefined;
  fieldMemory?: FieldMemory | undefined;
  onUsage?: ((report: TurnUsageReport) => void) | undefined;
  now?: (() => number) | undefined;
}

export interface ServerAdapter {
  readonly deltas: ServerDeltas;
  fingerprint(probe: ServerProbe): Promise<ServerFingerprint | undefined>;
  inventory(probe: ServerProbe): Promise<ServerInventory>;
  describe(
    probe: ServerProbe,
    model: string,
    fingerprint: ServerFingerprint,
  ): Promise<CapabilityRecord>;
  health(probe: ServerProbe, model?: string): Promise<HealthReading>;
  chat(options: ChatOptions): Provider;
}
