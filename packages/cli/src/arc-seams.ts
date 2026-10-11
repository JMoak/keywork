import { type CurationJudgmentPort, closingJudgment, type Provider } from "@keywork/engine";
import type { ClosingRequest } from "./arcs.ts";
import { listSessions } from "./sessions/store.ts";

export type ClosingSeam = (request: ClosingRequest) => CurationJudgmentPort | undefined;

export function closingSeamFor(providerFor: (arc: string) => Provider | undefined): ClosingSeam {
  return (request) => {
    const provider = providerFor(request.arc);
    if (provider === undefined) return undefined;
    return closingJudgment({
      provider,
      ...(request.direction !== undefined && { direction: request.direction }),
      onDegrade: request.onDegrade,
    });
  };
}

export async function latestArcActivity(
  sessionDir: string,
  slug: string,
): Promise<string | undefined> {
  const { sessions } = await listSessions(sessionDir);
  return sessions
    .filter((session) => session.arc === slug)
    .map((session) => session.lastActivityAt)
    .sort()
    .at(-1);
}
