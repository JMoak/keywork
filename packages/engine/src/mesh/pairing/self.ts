import type { TailnetInfo, TailnetStatus } from "../transport/status.ts";
import type { SelfIdentity, TailnetIdentitySource } from "./machine.ts";

export class SelfUnknownError extends Error {
  constructor(detail: string) {
    super(`this node cannot identify itself on the tailnet: ${detail}`);
    this.name = "SelfUnknownError";
  }
}

export function selfIdentityOf(status: TailnetStatus): SelfIdentity {
  if (status.self === null) throw new SelfUnknownError("tailscale status reports no Self");
  if (status.tailnet === null) throw new SelfUnknownError("tailscale status reports no tailnet");
  const tagged = status.self.tags.length > 0;
  const tailnet = tailnetIdentityOf(status.tailnet);
  return {
    stableId: status.self.stableId,
    tailnetId: tailnet.id,
    userId: tagged ? null : status.self.userId,
    source: tailnet.source,
  };
}

export function tailnetIdentityOf(tailnet: TailnetInfo): {
  id: string;
  source: TailnetIdentitySource;
} {
  if (tailnet.stableId !== "") return { id: tailnet.stableId, source: "stable-id" };
  if (tailnet.magicDNSSuffix !== "") return { id: tailnet.magicDNSSuffix, source: "magicdns" };
  throw new SelfUnknownError(
    "tailscale status names neither a tailnet StableID nor a MagicDNS suffix",
  );
}
