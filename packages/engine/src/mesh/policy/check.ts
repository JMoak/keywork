import type { TailnetStatus } from "../transport/status.ts";
import { readPolicy } from "./document.ts";
import { PolicyTextError } from "./hujson.ts";
import { controlPlaneOf, houseOf, parcelsOf } from "./nodes.ts";
import { type PolicyReport, type SteadPorts, verifyMeshPolicy } from "./verify.ts";

export interface PolicyCheckRequest {
  text: string;
  status: TailnetStatus;
  ports: SteadPorts;
  paired?: readonly string[] | undefined;
}

export function checkMeshPolicy(request: PolicyCheckRequest): PolicyReport {
  const { status } = request;
  const house = houseOf(status);
  if (house === null) {
    throw new PolicyTextError(
      "tailscale status reports no Self, so there is no house to check from",
    );
  }
  return verifyMeshPolicy({
    policy: readPolicy(request.text),
    house,
    parcels: parcelsOf(status, request.paired),
    ports: request.ports,
    controlPlane: controlPlaneOf(status),
  });
}
