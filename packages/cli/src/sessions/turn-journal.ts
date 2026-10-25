import {
  recordTurnFacts,
  type SessionStore,
  settledTurnFacts,
  type TurnFacts,
  type TurnTrees,
} from "@keywork/engine";

export async function freezeTurn(
  store: SessionStore,
  promptId: string,
  checkpoint: string | undefined,
  trees: TurnTrees | undefined,
): Promise<void> {
  await recordTurnFacts(store, await factsOf(store, promptId, checkpoint, trees));
}

function factsOf(
  store: SessionStore,
  prompt: string,
  checkpoint: string | undefined,
  trees: TurnTrees | undefined,
): Promise<TurnFacts> {
  if (trees === undefined) {
    return Promise.resolve({ prompt, ...(checkpoint !== undefined && { checkpoint }), files: [] });
  }
  return settledTurnFacts(trees, store, prompt, checkpoint);
}
