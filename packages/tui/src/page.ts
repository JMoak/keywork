export type PageTier = "broadsheet" | "column" | "clipping" | "masthead";

export interface PageGrammar {
  readonly tier: PageTier;
  readonly proseGutter: number;
  readonly proseMeasure: number | undefined;
  readonly toneDepth: 3 | 4;
  readonly masthead: boolean;
}

export interface PageThresholds {
  readonly broadsheetAt: number;
  readonly columnAt: number;
  readonly clippingAt: number;
}

export interface PageThresholdOverrides {
  readonly broadsheetAt?: number | undefined;
  readonly columnAt?: number | undefined;
  readonly clippingAt?: number | undefined;
}

export const pageTierThresholds: PageThresholds = {
  broadsheetAt: 100,
  columnAt: 70,
  clippingAt: 40,
};

export const broadsheetProseMeasure = 88;

export function resolvePage(
  paneWidth: number,
  thresholds: PageThresholds = pageTierThresholds,
): PageGrammar {
  return pageGrammars[tierAt(paneWidth, thresholds)];
}

export function resolvePageThresholds(overrides: PageThresholdOverrides = {}): PageThresholds {
  const resolved: PageThresholds = {
    broadsheetAt: overrides.broadsheetAt ?? pageTierThresholds.broadsheetAt,
    columnAt: overrides.columnAt ?? pageTierThresholds.columnAt,
    clippingAt: overrides.clippingAt ?? pageTierThresholds.clippingAt,
  };
  for (const [name, columns] of Object.entries(resolved)) {
    if (!Number.isInteger(columns) || columns < 1) {
      throw new Error(`Page threshold "${name}" needs a whole column count, got ${columns}`);
    }
  }
  if (resolved.clippingAt >= resolved.columnAt || resolved.columnAt >= resolved.broadsheetAt) {
    throw new Error(
      `Page thresholds must rise clippingAt < columnAt < broadsheetAt, got ${resolved.clippingAt} / ${resolved.columnAt} / ${resolved.broadsheetAt}`,
    );
  }
  return resolved;
}

export function proseWidth(page: PageGrammar, bleedWidth: number): number {
  const betweenGutters = bleedWidth - 2 * page.proseGutter;
  return Math.max(1, Math.min(page.proseMeasure ?? betweenGutters, betweenGutters));
}

export const columnPage: PageGrammar = {
  tier: "column",
  proseGutter: 0,
  proseMeasure: undefined,
  toneDepth: 3,
  masthead: false,
};

const pageGrammars: Record<PageTier, PageGrammar> = {
  broadsheet: {
    tier: "broadsheet",
    proseGutter: 1,
    proseMeasure: broadsheetProseMeasure,
    toneDepth: 4,
    masthead: false,
  },
  column: columnPage,
  clipping: {
    tier: "clipping",
    proseGutter: 0,
    proseMeasure: undefined,
    toneDepth: 3,
    masthead: false,
  },
  masthead: {
    tier: "masthead",
    proseGutter: 0,
    proseMeasure: undefined,
    toneDepth: 3,
    masthead: true,
  },
};

function tierAt(paneWidth: number, thresholds: PageThresholds): PageTier {
  if (paneWidth >= thresholds.broadsheetAt) return "broadsheet";
  if (paneWidth >= thresholds.columnAt) return "column";
  if (paneWidth >= thresholds.clippingAt) return "clipping";
  return "masthead";
}
