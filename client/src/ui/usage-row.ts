// Do the usage cards fit on the same line as the other items of the top bar (brand, counters, buttons)?
// Pure (no DOM): tested in ui/usage-row.test.ts. UsageCards (ui/usage.ts) is what measures the DOM and applies the
// result: when they don't fit, the bar gets a second line just for them.

export interface UsageRowInput {
  /** Usable width of the bar (without the padding). */
  barWidth: number;
  /** Widths of the other visible items of the bar. */
  others: number[];
  /** Space between the items of the bar. */
  gap: number;
  /** Space between the cards. */
  cardGap: number;
  /** Minimum width of each card (the smallest it accepts before losing content). */
  cards: number[];
}

export function usageRowFits(i: UsageRowInput): boolean {
  if (i.cards.length === 0) return true;
  // One space between each item of the bar: the other items plus the row of cards.
  const used = i.others.reduce((sum, w) => sum + w, 0) + i.gap * i.others.length;
  const need = i.cards.reduce((sum, w) => sum + w, 0) + i.cardGap * (i.cards.length - 1);
  return need <= i.barWidth - used;
}
