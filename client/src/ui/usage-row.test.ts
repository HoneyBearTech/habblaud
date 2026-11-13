import { describe, expect, it } from 'vitest';
import { usageRowFits, type UsageRowInput } from './usage-row';

// Real measurements of the bar in the demo (5 accounts, cards of at least 128 px): brand 265, counters 179, buttons 249.
const bar = (over: Partial<UsageRowInput> = {}): UsageRowInput => ({
  barWidth: 1182,
  others: [265, 179, 249],
  gap: 12,
  cardGap: 8,
  cards: [128, 128, 128, 128, 128],
  ...over,
});

describe('usageRowFits', () => {
  it('with no cards it always fits', () => {
    expect(usageRowFits(bar({ cards: [] }))).toBe(true);
  });

  it('fits when there is room left after the other items', () => {
    expect(usageRowFits(bar({ barWidth: 1420 }))).toBe(true);
  });

  it('5 accounts in a 1200 px window do not fit: 453 px are left for 672 px of cards', () => {
    expect(usageRowFits(bar())).toBe(false);
  });

  it('the limit is exact: a tight fit still fits', () => {
    // used = 265 + 179 + 249 + 3 x 12 = 729; cards = 5 x 128 + 4 x 8 = 672 -> minimum width 1401.
    expect(usageRowFits(bar({ barWidth: 1401 }))).toBe(true);
    expect(usageRowFits(bar({ barWidth: 1400 }))).toBe(false);
  });

  it('the smaller the card, the more accounts fit', () => {
    expect(usageRowFits(bar({ barWidth: 1182, cards: [128, 128] }))).toBe(true);
    expect(usageRowFits(bar({ barWidth: 1182, cards: [188, 188, 188, 188, 188] }))).toBe(false);
  });

  it('a single card does not pay for space between cards', () => {
    // 249 + 265 + 179 + 36 = 729 used; 453 free: a card of 453 fits, one of 454 doesn't.
    expect(usageRowFits(bar({ barWidth: 1182, cards: [453] }))).toBe(true);
    expect(usageRowFits(bar({ barWidth: 1182, cards: [454] }))).toBe(false);
  });
});
