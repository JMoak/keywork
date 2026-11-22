import {
  arrangementReaches,
  arrangementRelations,
  arrangementRests,
  arrangementShapes,
  arrangementSides,
} from "./arrangement.ts";
import { type Mood, moods, settingPlaces, settingSizes, settingWeights } from "./setting.ts";
import { vocabularyOf } from "./words.ts";

const articles = ["the", "a", "an"];

export const placeWords = vocabularyOf(settingPlaces, {
  aliases: {
    inside: "beside",
    inline: "beside",
    docked: "beside",
    panel: "beside",
    window: "outside",
    out: "outside",
    external: "outside",
    floating: "outside",
    detached: "outside",
    popout: "outside",
    "pop out": "outside",
    "own window": "outside",
    "new window": "outside",
  },
  filler: [...articles, "conversation", "console", "in", "its", "of"],
});

export const sizeWords = vocabularyOf(settingSizes, {
  aliases: {
    small: "card",
    compact: "card",
    glance: "card",
    medium: "readable",
    reading: "readable",
    read: "readable",
    large: "working",
    big: "working",
    work: "working",
    editing: "working",
  },
  filler: [...articles, "size", "sized"],
});

export const weightWords = vocabularyOf(settingWeights, {
  aliases: {
    main: "lead",
    primary: "lead",
    hero: "lead",
    focus: "lead",
    leading: "lead",
    supporting: "support",
    secondary: "support",
    side: "aside",
    minor: "aside",
    background: "aside",
    tertiary: "aside",
  },
  filler: articles,
});

export const moodWords = vocabularyOf(moods, {
  aliases: {
    relaxed: "calm",
    gentle: "calm",
    slow: "calm",
    soft: "calm",
    unhurried: "calm",
    normal: "brisk",
    default: "brisk",
    neutral: "brisk",
    quick: "eager",
    fast: "eager",
    excited: "eager",
    keen: "eager",
    lively: "playful",
    fun: "playful",
    whimsical: "playful",
    celebratory: "playful",
    celebrating: "playful",
    festive: "playful",
    joyful: "playful",
    happy: "playful",
    cheerful: "playful",
    proud: "playful",
    delighted: "playful",
    quiet: "calm",
    tidy: "calm",
    peaceful: "calm",
    serene: "calm",
    thoughtful: "calm",
    curious: "eager",
    enthusiastic: "eager",
    immediate: "urgent",
    now: "urgent",
    critical: "urgent",
    alarm: "urgent",
    alarmed: "urgent",
    decided: "decisive",
    settled: "decisive",
    resolved: "decisive",
    final: "decisive",
    firm: "decisive",
    confident: "decisive",
    certain: "decisive",
    sure: "decisive",
    determined: "decisive",
    serious: "decisive",
    hesitant: "tentative",
    unsure: "tentative",
    uncertain: "tentative",
    cautious: "tentative",
    careful: "tentative",
    shy: "tentative",
    sorry: "tentative",
    apologetic: "tentative",
    doubtful: "tentative",
    wary: "tentative",
  },
  filler: articles,
});

export const moodManners: Readonly<Record<Mood, string>> = {
  calm: "calmly",
  brisk: "briskly",
  eager: "eagerly",
  playful: "playfully",
  urgent: "urgently",
  decisive: "decisively",
  tentative: "tentatively",
};

export const moodsDescribed =
  "calm (slow and soft), brisk (the default, plain), eager (quick, close together), playful (out of turn, in a rhythm), urgent (all at once, fast), decisive (all at once, landing firmly) or tentative (a little slow, one at a time with pauses, landing lightly)";

export function mannerOf(mood: Mood, said: string | undefined): string {
  const asSaid = said?.trim().toLowerCase();
  return asSaid === undefined || asSaid === mood
    ? moodManners[mood]
    : `${moodManners[mood]}, the nearest mood to ${JSON.stringify(asSaid.slice(0, 40))}`;
}

export const shapeWords = vocabularyOf(arrangementShapes, {
  aliases: {
    tiles: "grid",
    tiled: "grid",
    mosaic: "grid",
    "side by side": "columns",
    stacked: "rows",
    "lead cards": "lead-and-cards",
    "lead stack": "lead-and-stack",
    halves: "split",
    kanban: "board",
  },
  synonyms: {
    column: "columns",
    row: "rows",
    card: "cards",
    main: "lead",
    master: "lead",
    primary: "lead",
    hero: "lead",
    with: "and",
  },
  filler: [...articles, "layout", "shape"],
});

export const relationWords = vocabularyOf(arrangementRelations, {
  aliases: {
    steps: "sequence",
    ordered: "sequence",
    order: "sequence",
    timeline: "sequence",
    flow: "sequence",
    options: "alternatives",
    choices: "alternatives",
    comparison: "alternatives",
    compare: "alternatives",
    alternative: "alternatives",
    task: "tasks",
    todo: "tasks",
    todos: "tasks",
    note: "notes",
    references: "notes",
  },
  filler: articles,
});

export const restWords = vocabularyOf(arrangementRests, {
  aliases: {
    cards: "beside",
    card: "beside",
    aside: "beside",
    away: "beside",
    back: "beside",
    "step back": "beside",
    "step aside": "beside",
    hide: "beside",
    rail: "beside",
    keep: "stay",
    leave: "stay",
    same: "stay",
    still: "stay",
    untouched: "stay",
  },
  filler: [...articles, "conversation", "as", "where", "they", "are"],
});

export const sideWords = vocabularyOf(arrangementSides, {
  aliases: {
    west: "left",
    east: "right",
    above: "top",
    up: "top",
    upper: "top",
    north: "top",
    below: "bottom",
    down: "bottom",
    lower: "bottom",
    under: "bottom",
    south: "bottom",
  },
  filler: [...articles, "side", "hand", "on", "at", "of"],
});

export const reachWords = vocabularyOf(arrangementReaches, {
  aliases: {
    stage: "room",
    screen: "display",
    desktop: "display",
    everything: "display",
    fullscreen: "display",
    "work area": "display",
  },
  filler: [...articles, "whole", "entire"],
});
