// Cartões: bandeira só de código ISO-2, andares com teto de 24 ("24+"), mês sem fuso, modo discreto, perfil.
import { describe, expect, it } from 'vitest';
import type { WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';
import { CARD_MAX_FLOORS, buildingCardModel, flagEmoji, floorsLabel, likesLabel, monthLabel, playerCardModel } from './cards';

const b: WorldBuildingPublic = { id: 'b1', lot: { district: 'centro', x: 3, y: 0 }, owner: { id: 'o1', name: 'Ana Pixel', country: 'br' }, state: 'online', theme: 'none', floors: 30, agents: { total: 5, working: 2, waiting: 1, idle: 2 }, rev: 1, likes: 12, sinceMonth: '2026-10' };

describe('building card', () => {
  it('country flag (emoji) only for two letters', () => {
    expect(flagEmoji('BR')).toBe('🇧🇷');
    expect(flagEmoji('fr')).toBe('🇫🇷');
    expect(flagEmoji('BRA')).toBe('');
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji(undefined)).toBe('');
  });

  it('floors: the facade goes up to 12 with "+N"; the card shows up to 24 and "24+" above that', () => {
    expect(CARD_MAX_FLOORS).toBe(24);
    expect(floorsLabel(0)).toBe('ground floor only');
    expect(floorsLabel(1)).toBe('1 floor');
    expect(floorsLabel(16)).toBe('16 floors');
    expect(floorsLabel(24)).toBe('24 floors');
    expect(floorsLabel(25)).toBe('24+ floors');
  });

  it('the joining month is that of local day 1 (without falling into the previous month because of the time zone)', () => {
    expect(monthLabel('2026-10')).toMatch(/October/);
    expect(monthLabel('2026-10')).toMatch(/2026/);
    expect(monthLabel('2026-13')).toBe('');
    expect(monthLabel('junk')).toBe('');
  });

  it('model: state, agents (or discreet mode), likes and "in the world since"', () => {
    const m = buildingCardModel(b, 'b1');
    expect(m).toMatchObject({ owner: 'Ana Pixel', flag: '🇧🇷', online: true, state: 'Lights on', floors: '24+ floors', agents: { working: 2, waiting: 1, idle: 2 }, likes: '12 likes', closed: false, mine: true });
    expect(m.since).toMatch(/October/);
    const d = buildingCardModel({ ...b, agents: undefined, state: 'away', closed: true }, null);
    expect(d.agents).toBeNull();
    expect(d.state).toBe('Lights off');
    expect(d.closed).toBe(true);
    expect(d.mine).toBe(false);
    expect(likesLabel(1)).toBe('1 like');
  });
});

describe('player card', () => {
  it('traits with emoji, translated phrase, likes received and the building (if the city knows it)', () => {
    const p: WorldPlayerPublic = { id: 'w1', name: 'Luna', country: 'JP', look: 'f', parts: {}, traits: ['games', 'cafeina', 'nonexistent' as never], intro: 'coffee', buildingId: 'b1', likesReceived: 3, pos: { x: 0, y: 0, dir: 's', moving: false }, where: 'street' };
    const m = playerCardModel(p, b);
    expect(m.flag).toBe('🇯🇵');
    expect(m.traits.map((t) => t.emoji)).toEqual(['🎮', '☕']);
    expect(m.intro).toBe('Powered by coffee');
    expect(m.likes).toBe('3 likes');
    expect(m.building).toEqual({ id: 'b1', floors: '24+ floors', online: true });
    const far = playerCardModel(p, undefined);
    expect(far.building).toBeNull();
    expect(far.hasBuilding).toBe(true);
  });
});
