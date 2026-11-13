// The social side inside the building (Phase 5), the pure part: today's stamp (UTC day) and the reception's stamp board.
import { describe, expect, it } from 'vitest';
import { stampBoard, stampedToday, stampKey, stampPinTitle, stampReply, utcDay } from './visit-social';

describe("today's stamp", () => {
  it("one per building per UTC day; yesterday's, an id outside the list or garbage do not count", () => {
    const day = utcDay(Date.UTC(2026, 9, 15, 23, 59));
    expect(day).toBe('2026-10-15');
    expect(stampedToday(JSON.stringify({ day, stampId: 'rocket' }), day)).toBe('rocket');
    expect(stampedToday(JSON.stringify({ day: '2026-10-14', stampId: 'rocket' }), day)).toBeNull();
    expect(stampedToday(JSON.stringify({ day, stampId: 'free text' }), day)).toBeNull();
    expect(stampedToday('{', day)).toBeNull();
    expect(stampedToday(null, day)).toBeNull();
    expect(stampKey('b1')).toBe('habblaud:world-stamp:b1');
  });
});

describe('reception stamp board', () => {
  it('mine first, then the most received; positions inside the board and the same on every call', () => {
    const entries = [{ stampId: 'star' as const, count: 3 }, { stampId: 'coffee' as const, count: 1 }, { stampId: 'rocket' as const, mine: true }];
    const a = stampBoard(entries, 7);
    expect(a.map((p) => p.stampId)).toEqual(['rocket', 'star', 'coffee']);
    expect(a[0]).toMatchObject({ mine: true, icon: '🚀' });
    for (const p of a) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
      expect(Math.abs(p.rot)).toBeLessThanOrEqual(12);
    }
    expect(stampBoard(entries, 7)).toEqual(a);
    expect(stampPinTitle(a[1]!)).toBe('Top marks ×3');
  });

  it('at most `max` stamps; ids outside the list are left out', () => {
    const many = Array.from({ length: 12 }, () => ({ stampId: 'heart' as const }));
    expect(stampBoard(many, 1, 8)).toHaveLength(8);
    expect(stampBoard([{ stampId: 'xx' as never }], 1)).toEqual([]);
  });
});

describe('the response to a stamp', () => {
  it('stamped confirms (the stamp stays), already_done says there was one already, the rest undoes it', () => {
    expect(stampReply('stamped')).toBe('ok');
    expect(stampReply('already_done')).toBe('already');
    for (const t of ['too_far', 'not_found', 'blocked', 'rate_limited', 'new_id']) expect(stampReply(t), t).toBe('failed');
  });
});
