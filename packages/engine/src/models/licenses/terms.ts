import type { Slate, SlateModel } from "../bench/slate.ts";
import { type LicenseAcknowledgement, licenseAcknowledgementFor } from "../discovery/inventory.ts";

export interface LicenseTerms {
  license: string | null;
  acknowledgement: LicenseAcknowledgement;
  released: string | null;
}

export function licenseTermsFor(
  model: string,
  served: string | null,
  slate: Slate | undefined,
): LicenseTerms {
  const entry = slate === undefined ? undefined : slateEntryFor(slate, model);
  const license = served ?? entry?.license.id ?? null;
  return {
    license,
    acknowledgement: acknowledgementOf(license, entry),
    released: entry?.released ?? null,
  };
}

export function slateEntryFor(slate: Slate, model: string): SlateModel | undefined {
  const forms = servedForms(model);
  return slate.models
    .filter((entry) => forms.some((form) => namesEntry(form, entry.id.toLowerCase())))
    .sort((left, right) => right.id.length - left.id.length)[0];
}

export function sameLicense(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function acknowledgementOf(
  license: string | null,
  entry: SlateModel | undefined,
): LicenseAcknowledgement {
  if (license === null) return "unknown";
  if (entry !== undefined && sameLicense(license, entry.license.id)) {
    return entry.license.acknowledgement === "required" ? "required" : "not-required";
  }
  return licenseAcknowledgementFor(license);
}

function servedForms(model: string): string[] {
  const lowered = model.trim().toLowerCase();
  const fileName = lowered.split("/").at(-1) ?? lowered;
  return [...new Set([lowered, fileName].map(withoutPackaging))];
}

function withoutPackaging(name: string): string {
  return name
    .replace(/\.gguf$/, "")
    .replace(/:latest$/, "")
    .replaceAll(":", "-");
}

function namesEntry(form: string, id: string): boolean {
  return form === id || variantSeparators.some((separator) => form.startsWith(`${id}${separator}`));
}

const variantSeparators = ["-", ".", "_"];
