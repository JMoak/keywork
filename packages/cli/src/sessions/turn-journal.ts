import {
  recordTurnFacts,
  type SessionStore,
  settledTurnFacts,
  type TurnEnding,
  type TurnFacts,
  type TurnTrees,
} from "@keywork/engine";

export async function freezeTurn(
  store: SessionStore,
  promptId: string,
  checkpoint: string | undefined,
  trees: TurnTrees | undefined,
  ending?: TurnEnding,
): Promise<void> {
  const facts = await factsOf(store, promptId, checkpoint, trees);
  await recordTurnFacts(store, { ...facts, ...ending });
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
