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
  await freezeTurnFacts(store, await turnFactsAt(store, promptId, checkpoint, trees), ending);
}

export async function freezeTurnFacts(
  store: SessionStore,
  facts: TurnFacts,
  ending?: TurnEnding,
): Promise<void> {
  await recordTurnFacts(store, { ...facts, ...ending });
}

export function turnFactsAt(
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
