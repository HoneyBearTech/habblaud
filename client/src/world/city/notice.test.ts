// World notices in the scene: each id in NOTICE_IDS has its text (or nothing, if it only matters to whoever debugs),
// and an id this version does not know becomes the generic one. The door ones (Phase 4) say where I am: at the door
// or put outside.
import { describe, expect, it } from 'vitest';
import { NOTICE_IDS } from '../../../../shared/world/protocol';
import { noticeText } from './notice';

describe('noticeText', () => {
  it('each protocol id has its own text or none; an unknown id gets the generic one', () => {
    const generic = noticeText('new_id');
    expect(generic).toBeTruthy();
    const texts = NOTICE_IDS.map((id) => noticeText(id));
    // No text: `ignored`, `invalid` and `view_required` (only for whoever debugs).
    expect(texts.filter((t) => t === null)).toHaveLength(3);
    const shown = texts.filter((t): t is string => t !== null);
    expect(new Set([...shown, generic]).size).toBe(shown.length + 1);
  });

  it('the door (Phase 4): not_found talks about the building at the door and inside; closed and blocked say that you went back to the street', () => {
    expect(noticeText('not_found')).not.toBe(noticeText('not_found', 'door'));
    expect(noticeText('not_found', 'door')).not.toBe(noticeText('not_found', 'inside'));
    for (const id of ['too_far', 'closed', 'blocked', 'full'] as const) expect(noticeText(id, 'door'), id).toBeTruthy();
    expect(noticeText('closed', 'inside')).not.toBe(noticeText('closed', 'door'));
    expect(noticeText('blocked', 'inside')).not.toBe(noticeText('blocked', 'door'));
  });
});
