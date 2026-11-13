// Pure rules of the world's text layer (speech bubbles and framing).
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../../../shared/i18n';
import { overviewFrame } from '../camera';
import { rationBubbles, waitBubbleText } from './overlay';

describe('speech bubbles', () => {
  afterEach(() => setLocale('en'));

  it('waiting: only the reason, without the redundant prefix', () => {
    expect(waitBubbleText('approve a permission')).toBe('Approve a permission');
    expect(waitBubbleText('Needs you: choose an option')).toBe('Choose an option');
    expect(waitBubbleText('needs you')).toBe('Answer in terminal');
    expect(waitBubbleText(undefined)).toBe('Answer in terminal');
    expect(waitBubbleText('   ')).toBe('Answer in terminal');
    // A server in Portuguese and a page in English: the Portuguese prefix is recognized too.
    expect(waitBubbleText('aprovar uma permissão')).toBe('Aprovar uma permissão');
    expect(waitBubbleText('Precisa de você: escolher uma opção')).toBe('Escolher uma opção');
    // A page in Portuguese, with a server in Portuguese or in English.
    setLocale('pt-BR');
    expect(waitBubbleText('Precisa de você: escolher uma opção')).toBe('Escolher uma opção');
    expect(waitBubbleText('Needs you: choose an option')).toBe('Choose an option');
    expect(waitBubbleText(undefined)).toBe('Responder no terminal');
  });

  it('overview: at most 1 speech bubble with text per area and 4 on screen (most recent first)', () => {
    const items = [
      { room: 'a', prio: 50, changedAt: 10 },
      { room: 'a', prio: 50, changedAt: 30 },
      { room: 'a', prio: 50, changedAt: 20 },
      { room: 'b', prio: 30, changedAt: 99 },
      { room: 'c', prio: 50, changedAt: 1 },
      { room: 'd', prio: 50, changedAt: 2 },
      { room: 'e', prio: 50, changedAt: 3 },
    ];
    const keep = rationBubbles(items, 1, 4);
    expect(keep.size).toBe(4);
    expect(keep.has(1)).toBe(true); // the most recent one of area "a"
    expect(keep.has(0) || keep.has(2)).toBe(false);
    expect(keep.has(3)).toBe(false); // lower priority loses to the other areas
  });
});

describe('overview', () => {
  const building = { x: 0, y: 0, w: 4 * 16 * 16, h: 29 * 16 };

  it('frames the building in the free area (outside the panels), with room for the signs above', () => {
    const free = overviewFrame(building, 1440, 900, { top: 0, right: 0, bottom: 0, left: 0 });
    const ui = overviewFrame(building, 1440, 900, { top: 64, right: 0, bottom: 200, left: 320 });
    expect(ui.zoom).toBeLessThan(free.zoom);
    // the framing height (signs + building + curb) fits between the top bar and the bottom one
    const h = (building.h + 3.5 * 16) * ui.zoom;
    expect(h).toBeLessThanOrEqual(900 - 64 - 200 - 30);
    // starts above the north wall (signs) and ends below the south facade
    expect(ui.cy).toBeGreaterThan(building.h / 2);
    expect(ui.dy).toBeGreaterThan(0);
  });
});
