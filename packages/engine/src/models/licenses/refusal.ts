import { formatReference } from "../../inference/references.ts";
import type { Slate } from "../bench/slate.ts";
import type { PolicyEnvironment } from "../policy/resolve.ts";
import type { LicenseBook } from "./book.ts";
import { licenseTermsFor } from "./terms.ts";

export type CandidateRefusal = NonNullable<PolicyEnvironment["refusalOf"]>;

export const licenseAcknowledgementCapability = "license-acknowledgement";

export function unacknowledgedLicense(
  book: Pick<LicenseBook, "acknowledgementOf">,
  slate?: Slate | undefined,
): CandidateRefusal {
  return (binding, capabilities) => {
    const model = binding.reference.model;
    const served = capabilities.license.known ? capabilities.license.value : null;
    const { license, acknowledgement } = licenseTermsFor(model, served, slate);
    if (license === null || acknowledgement !== "required") return undefined;
    if (book.acknowledgementOf(model, license) !== undefined) return undefined;
    const reference = formatReference(binding.reference);
    return {
      code: "missing-capability",
      reference,
      model,
      capability: licenseAcknowledgementCapability,
      message: `${reference} runs under ${license}, which needs the keeper's acknowledgement before any class may use it`,
    };
  };
}
