import type { ModelReference, ProviderRegistration } from "../../inference/types.ts";
import type { BenchBook, BenchOutcome, BenchTarget } from "../bench/book.ts";
import type { BenchReport } from "../bench/run.ts";
import type { Slate } from "../bench/slate.ts";
import type {
  ModelInventory,
  ModelProbeReport,
  ModelProbeRequest,
  ModelRow,
  ModelsFilter,
  ModelsReport,
  NodeModels,
  ServerRow,
} from "../discovery/inventory.ts";
import type { ProviderAnswers } from "../health/answers.ts";
import { type InheritedClasses, inheritedClasses } from "../policy/inherit.ts";
import type { PolicyEnvironment } from "../policy/resolve.ts";
import type { AcknowledgementRequest, LicenseBook, ModelAcknowledgement } from "./book.ts";
import { type MarketModelRow, type MarketServerRow, marketOf } from "./market.ts";
import { licenseTermsFor } from "./terms.ts";

export interface StewardedModelFacts {
  released: string | null;
  acknowledgedAt: string | null;
}

export type StewardedModelRow = ModelRow & StewardedModelFacts;

export type StewardedMarketModelRow = MarketModelRow & StewardedModelFacts;

export interface StewardedServerRow extends Omit<ServerRow, "models"> {
  models: StewardedModelRow[];
}

export interface StewardedMarketServerRow extends Omit<MarketServerRow, "models"> {
  models: StewardedMarketModelRow[];
}

export interface StewardedModelsReport extends Omit<ModelsReport, "nodes"> {
  nodes: (Omit<NodeModels, "servers"> & { servers: StewardedServerRow[] })[];
  market?: StewardedMarketServerRow[];
  inherits?: InheritedClasses;
}

export interface ModelStewardship {
  licenses: LicenseBook;
  benches: BenchBook;
  slate?: Slate | undefined;
  registrations?: (() => readonly ProviderRegistration[]) | undefined;
  answers?: ProviderAnswers | undefined;
  inherit?: (() => ModelReference | undefined) | undefined;
  policy?: Pick<PolicyEnvironment, "capabilityOf" | "refusalOf"> | undefined;
  now?: (() => Date) | undefined;
}

export interface StewardedInventory {
  list(filter?: ModelsFilter): Promise<StewardedModelsReport>;
  probe(request: ModelProbeRequest): Promise<ModelProbeReport>;
  acknowledge(request: AcknowledgementRequest): Promise<ModelAcknowledgement>;
  bench(target: BenchTarget): Promise<BenchOutcome>;
  lastBench(target: BenchTarget): Promise<BenchReport | null>;
}

export function stewardedInventory(
  inventory: Pick<ModelInventory, "list" | "probe">,
  stewardship: ModelStewardship,
): StewardedInventory {
  const now = stewardship.now ?? (() => new Date());
  const steward = <Row extends ModelRow | MarketModelRow>(row: Row) =>
    stewardedRow(row, stewardship);
  return {
    list: async (filter = {}) => {
      const report = await inventory.list(filter);
      return {
        ...report,
        nodes: report.nodes.map((node) => ({
          ...node,
          servers: node.servers.map((server) => ({
            ...server,
            models: server.models.map(steward),
          })),
        })),
        ...(filter.node === undefined && hostWide(stewardship, now(), steward)),
      };
    },
    probe: (request) => inventory.probe(request),
    acknowledge: async (request) => stewardship.licenses.acknowledge(request),
    bench: (target) => stewardship.benches.run(target),
    lastBench: (target) => stewardship.benches.last(target),
  };
}

type StewardedFacts = Pick<ModelRow, "license" | "licenseAcknowledgement"> & StewardedModelFacts;

function hostWide(
  { registrations, answers, inherit, policy }: ModelStewardship,
  now: Date,
  steward: (row: MarketModelRow) => StewardedMarketModelRow,
): Pick<StewardedModelsReport, "market" | "inherits"> {
  if (registrations === undefined) return {};
  const registered = registrations();
  return {
    market: marketOf(registered, now, answers).map((server) => ({
      ...server,
      models: server.models.map(steward),
    })),
    ...(inherit !== undefined && {
      inherits: inheritedClasses(inherit(), {
        registrations: registered,
        ...policy,
        now: () => now,
      }),
    }),
  };
}

function stewardedRow<Row extends ModelRow | MarketModelRow>(
  row: Row,
  stewardship: Pick<ModelStewardship, "licenses" | "slate">,
): Row & StewardedFacts {
  return { ...row, ...stewardedFacts(row, stewardship) };
}

function stewardedFacts(
  row: Pick<ModelRow, "id" | "license">,
  { licenses, slate }: Pick<ModelStewardship, "licenses" | "slate">,
): StewardedFacts {
  const terms = licenseTermsFor(row.id, row.license, slate);
  const acknowledged =
    terms.license === null ? undefined : licenses.acknowledgementOf(row.id, terms.license);
  return {
    license: terms.license,
    licenseAcknowledgement: terms.acknowledgement,
    released: terms.released,
    acknowledgedAt: acknowledged?.acknowledgedAt ?? null,
  };
}
