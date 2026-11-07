import { describe, expect, it } from "vitest";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import { readSlate } from "../bench/slate.ts";
import {
  blankRecord,
  type CapabilityRecord,
  known,
  type ServerFingerprint,
} from "../capabilities/index.ts";
import {
  type ModelCandidate,
  type PolicyEnvironment,
  type PolicyLevels,
  resolvePolicy,
} from "../policy/index.ts";
import {
  licenseAcknowledgementCapability,
  licenseTermsFor,
  memoryLicenseBook,
  slateEntryFor,
  unacknowledgedLicense,
} from "./index.ts";
import { testSlate } from "./testing.ts";

describe("slateEntryFor", () => {
  it("finds a model however its server spells it", () => {
    const found = (model: string) => slateEntryFor(testSlate, model)?.id;
    expect(found("qwen3.8:27b")).toBe("qwen3.8-27b");
    expect(found("/models/Qwen3.8-27B-Q4_K_M.gguf")).toBe("qwen3.8-27b");
    expect(found("nemotron-3-super:120b")).toBe("nemotron-3-super");
    expect(found("nimble:latest")).toBe("nimble");
    expect(found("typesafe/jev-1.14")).toBe("typesafe/jev-1.14");
  });

  it("prefers the longest slate id and never matches a name shorter than the entry", () => {
    expect(slateEntryFor(testSlate, "nimble-vision:8b")?.id).toBe("nimble-vision");
    expect(slateEntryFor(testSlate, "qwen3.8-flash")).toBeUndefined();
    expect(slateEntryFor(testSlate, "qwen3.8-27bx")).toBeUndefined();
  });
});

describe("licenseTermsFor", () => {
  it("takes the slate's word on a license the slate lists for that model", () => {
    expect(licenseTermsFor("laguna-xs-2.1", "OpenMDW-1.1", testSlate)).toEqual({
      license: "OpenMDW-1.1",
      acknowledgement: "not-required",
      released: null,
    });
    expect(licenseTermsFor("qwen3.8:27b", "apache-2.0", testSlate)).toMatchObject({
      acknowledgement: "not-required",
      released: "2026-08-05",
    });
  });

  it("fills a license the server does not report from the slate", () => {
    expect(licenseTermsFor("qwen3.8-flash-next", null, testSlate)).toEqual({
      license: "qwen-community-1.0",
      acknowledgement: "required",
      released: "2026-08-24",
    });
  });

  it("judges a served license the slate does not know as the inventory does", () => {
    expect(licenseTermsFor("qwen3.8-27b", "NVIDIA Open Model License", testSlate)).toMatchObject({
      license: "NVIDIA Open Model License",
      acknowledgement: "required",
    });
    expect(licenseTermsFor("mystery-7b", "MIT", testSlate).acknowledgement).toBe("not-required");
    expect(licenseTermsFor("mystery-7b", "qwen-community-1.0", undefined).acknowledgement).toBe(
      "required",
    );
    expect(licenseTermsFor("mystery-7b", null, testSlate)).toEqual({
      license: null,
      acknowledgement: "unknown",
      released: null,
    });
  });

  it("reads the shipped slate's non-permissive picks as needing acknowledgement", async () => {
    const shipped = await readSlate();
    expect(licenseTermsFor("qwen3.8-flash-next", null, shipped).acknowledgement).toBe("required");
    expect(licenseTermsFor("qwen3.8-27b", null, shipped).acknowledgement).toBe("not-required");
  });
});

const spark: ProviderRegistration = {
  name: "spark",
  protocol: "chat-completions",
  endpoint: "http://localhost:9931/v1",
  credential: { kind: "none" },
  models: [],
  openCatalog: true,
  enabled: true,
};

const probed = { source: "native-route", route: "/props" } as const;

function strongRecord(binding: InferenceBinding, license: string | null): CapabilityRecord {
  const server: ServerFingerprint = {
    id: "fp",
    kind: "llama-server",
    version: "b12122",
    build: null,
    routes: [],
  };
  return {
    ...blankRecord(binding.registration.endpoint, binding.reference.model, server, "2026-11-05"),
    tools: known(true, probed),
    contextAllocated: known(262_144, probed),
    ...(license !== null && { license: known(license, probed) }),
  };
}

function environment(
  licenses: Readonly<Record<string, string | null>>,
  book = memoryLicenseBook(),
): PolicyEnvironment {
  return {
    registrations: [spark],
    now: () => new Date("2026-11-05T12:00:00Z"),
    capabilityOf: (binding) => strongRecord(binding, licenses[binding.reference.model] ?? null),
    refusalOf: unacknowledgedLicense(book, testSlate),
  };
}

const flash = { provider: "spark", model: "qwen3.8-flash-next" };
const dense = { provider: "spark", model: "qwen3.8-27b" };

function strongPolicy(creature: ModelCandidate, workspace?: ModelCandidate): PolicyLevels {
  return {
    creature: { strong: creature },
    ...(workspace !== undefined && { workspace: { strong: workspace } }),
  };
}

describe("the policy resolver with unacknowledgedLicense", () => {
  const served = { "qwen3.8-flash-next": "qwen-community-1.0", "qwen3.8-27b": "Apache-2.0" };

  it("refuses an unacknowledged non-permissive model with missing-capability and falls back", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: strongPolicy(flash, dense) },
      environment(served),
    );
    if (!resolution.ok || resolution.kind !== "plan") throw new Error("expected a plan");
    expect(resolution.plan.candidates.map(({ binding }) => binding.reference)).toEqual([dense]);
    expect(resolution.plan.refused).toEqual([
      {
        level: "creature",
        candidate: flash,
        reason: "unresolved",
        failure: {
          code: "missing-capability",
          reference: "spark/qwen3.8-flash-next",
          model: "qwen3.8-flash-next",
          capability: licenseAcknowledgementCapability,
          message: expect.stringContaining("qwen-community-1.0"),
        },
      },
    ]);
  });

  it("fails resolution when the only candidate is unacknowledged", () => {
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: strongPolicy(flash) },
      environment(served),
    );
    expect(resolution).toMatchObject({
      ok: false,
      level: "creature",
      failure: { code: "missing-capability", capability: "license-acknowledgement" },
    });
  });

  it("admits the model once the keeper acknowledges that license", () => {
    const book = memoryLicenseBook();
    book.acknowledge({
      endpoint: "http://localhost:9931",
      model: "qwen3.8-flash-next",
      license: "Qwen-Community-1.0",
    });
    const resolution = resolvePolicy(
      { modelClass: "strong", levels: strongPolicy(flash, dense) },
      environment(served, book),
    );
    if (!resolution.ok || resolution.kind !== "plan") throw new Error("expected a plan");
    expect(resolution.plan.candidates.map(({ binding }) => binding.reference)).toEqual([
      flash,
      dense,
    ]);
    expect(resolution.plan.refused).toEqual([]);
  });

  it("refuses on the slate's license when the server reports none", () => {
    const resolution = resolvePolicy(
      {
        modelClass: "strong",
        levels: strongPolicy({ provider: "spark", model: "nemotron-3-super:120b" }),
      },
      environment({}),
    );
    expect(resolution).toMatchObject({
      ok: false,
      failure: { capability: "license-acknowledgement", model: "nemotron-3-super:120b" },
    });
  });

  it("lets permissive and unknown licenses through", () => {
    const unknown = { provider: "spark", model: "mystery-7b" };
    for (const candidate of [dense, unknown]) {
      const resolution = resolvePolicy(
        { modelClass: "strong", levels: strongPolicy(candidate) },
        environment(served),
      );
      expect(resolution).toMatchObject({ ok: true, kind: "plan" });
    }
  });
});
