// Avisos do mundo na cena: cada id de NOTICE_IDS tem o seu texto (ou nada, se só interessa a quem depura), e um id
// que esta versão não conhece vira o genérico. Os da porta (Fase 4) dizem onde estou: na porta ou posto para fora.
import { describe, expect, it } from 'vitest';
import { NOTICE_IDS } from '../../../../shared/world/protocol';
import { noticeText } from './notice';

describe('noticeText', () => {
  it('each protocol id has its own text or none; an unknown id gets the generic one', () => {
    const generic = noticeText('new_id');
    expect(generic).toBeTruthy();
    const texts = NOTICE_IDS.map((id) => noticeText(id));
    // Sem texto: `ignored`, `invalid` e `view_required` (só para quem depura).
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
