import type { Slate, SlateModel } from "../bench/slate.ts";

export function slateModel(
  id: string,
  license: string,
  acknowledgement: "none" | "required",
  released: string | null = null,
): SlateModel {
  return {
    id,
    label: id,
    roles: [{ class: "strong", role: "conversation", pick: false }],
    license: { id: license, acknowledgement },
    released,
    preview: false,
    parameters: { total: null, active: null },
    memoryQ4: null,
    contextTokens: null,
    bestMeasuredDecode: null,
    evidence: "test slate",
  };
}

export const testSlate: Slate = {
  asOf: "2026-11-05",
  source: "test slate",
  models: [
    slateModel("qwen3.8-27b", "Apache-2.0", "none", "2026-08-05"),
    slateModel("qwen3.8-flash-next", "qwen-community-1.0", "required", "2026-08-24"),
    slateModel("laguna-xs-2.1", "OpenMDW-1.1", "none"),
    slateModel("nemotron-3-super", "NVIDIA Open Model License", "required"),
    slateModel("nimble", "unverified", "required"),
    slateModel("nimble-vision", "Apache-2.0", "none"),
    slateModel("typesafe/jev-1.14", "hosted", "none"),
  ],
};
