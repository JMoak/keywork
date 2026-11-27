import type { KeeperAway } from "../notices/quiet.ts";
import type { Rung } from "../show/setting.ts";
import type { ShowProposal } from "../show/store.ts";

export function besideWhileAway(proposal: ShowProposal): ShowProposal {
  const { where, seat: _seat, size: _size, weight: _weight, ...rest } = proposal;
  return {
    ...rest,
    rung: heldRung(proposal.rung),
    ...(where === "beside" && { where }),
  };
}

export function awaySetOutWords(away: KeeperAway, count: number): string {
  const waits =
    count === 1
      ? "It waits beside the conversation as a card"
      : "They wait beside the conversation as cards";
  return `Nothing rose on their screen: ${awayClause(away)}. ${waits}, kept for their return.`;
}

export function awayArrangeWords(away: KeeperAway): string {
  return `Not arranged: ${awayClause(away)}, so nothing moves on their screen; your windows stay where they stand, and your work is kept for their return.`;
}

export function awayShownWords(away: KeeperAway): string {
  return `${capitalized(awayClause(away))}: nothing of yours rises on their screen meanwhile, and what you set out waits beside the conversation for their return.`;
}

function awayClause({ reason, until }: KeeperAway): string {
  if (reason === "do-not-disturb") return "the keeper has asked not to be disturbed for now";
  return until === null
    ? "the keeper is away (quiet hours)"
    : `the keeper is away until ${until} (quiet hours)`;
}

function heldRung(rung: Rung): Rung {
  return rung === "lantern" ? "lantern" : "card";
}

function capitalized(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
