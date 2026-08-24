import type { InferencePort } from "./inference-port.ts";
import { type ModelPicker, modelPickerOver } from "./model-picker.ts";

export interface InferenceCommandSeams {
  inference: InferencePort;
  currentModel: (() => string | undefined) | undefined;
  switchModel: ((reference: string) => Promise<string>) | undefined;
  notice(text: string): void;
  showPicker(picker: ModelPicker): void;
}

export function runModelCommand(seams: InferenceCommandSeams, argument: string): Promise<void> {
  const reference = argument.trim();
  if (reference !== "") return selectModel(seams, reference);
  seams.showPicker(modelPickerOver(seams.inference.choices(), seams.currentModel?.()));
  return Promise.resolve();
}

export async function selectModel(seams: InferenceCommandSeams, reference: string): Promise<void> {
  const resolution = seams.inference.describe(reference);
  if (!resolution.ok) {
    seams.notice(`${resolution.message} · ${resolution.nextAction ?? ""}`.trim());
    return;
  }
  if (seams.switchModel === undefined) return;
  seams.notice(await seams.switchModel(reference));
}
