// The building's automatic theme in World (server/world/theme.ts) follows the same calendar as the office (seasonalThemeFor).
import { describe, expect, it } from 'vitest';
import { resolveWorldTheme } from '../../../server/world/theme';
import { seasonalThemeFor } from './api';

describe('automatic theme: office and World', () => {
  it('the same theme on every day of 2026 and 2028 (leap year)', () => {
    for (const year of [2026, 2028]) {
      for (let t = new Date(year, 0, 1, 12); t.getFullYear() === year; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 12)) {
        expect(resolveWorldTheme('auto', t), t.toDateString()).toBe(seasonalThemeFor('auto', t));
      }
    }
  });
});
