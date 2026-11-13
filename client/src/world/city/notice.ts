// O texto de cada aviso do servidor do mundo na cena (`notice {level, text}`): o `text` é um id de NOTICE_IDS do
// protocolo, traduzido aqui (o servidor nunca manda frases). Alguns ids dizem coisas diferentes conforme onde estou:
// na rua, esperando a resposta de um `enter` (na porta) ou dentro de um prédio (posto para fora).
import { tr } from '../../../../shared/i18n';
import type { NoticeId } from '../../../../shared/world/protocol';

/** Onde o aviso chegou: na rua, logo depois de um `enter` (a porta) ou dentro de um prédio. */
export type NoticePlace = 'street' | 'door' | 'inside';

/**
 * Texto de um `notice` (o `text` é um id de NOTICE_IDS do protocolo, traduzido aqui; um id desconhecido vira um aviso
 * genérico). null = nada para mostrar (ids que só interessam a quem depura). Um id novo no protocolo sem `case` aqui
 * não compila.
 */
export function noticeText(raw: NoticeId | (string & {}), place: NoticePlace = 'street'): string | null {
  const id = raw as NoticeId;
  switch (id) {
    case 'ignored':
    case 'invalid':
    case 'view_required':
      return null;
    case 'rate_limited':
      return tr('Slow down: the world asked for a pause between actions.');
    case 'not_found':
      if (place === 'door') return tr("This building isn't in the world right now.");
      if (place === 'inside') return tr("The building left the world: you're back on the street.");
      return tr("That person isn't nearby anymore.");
    case 'street_left':
      return tr('You stood still for a long time and left the street: walk to come back.');
    case 'chunk_full':
      return tr('The area is full: only the closest players show up.');
    case 'afk':
      return tr('You stood still for a while.');
    case 'server_restart':
      return tr('Habblaud World is restarting: the connection drops and comes back on its own.');
    case 'left':
      return tr('Your account left the world: the building comes back with "Back to the world", in Settings.');
    case 'too_far':
      return tr('Get closer to the door to go in.');
    case 'closed':
      return place === 'inside' ? tr("The building closed to visitors: you're back on the street.") : tr('This building is closed to visitors.');
    case 'blocked':
      return place === 'inside' ? tr("You can't stay in this building anymore: you're back on the street.") : tr("You can't enter this building.");
    case 'full':
      return tr('The building is full (20 visitors). Try again in a bit.');
    // Fase 5 (social leve). As confirmações (reported, blocked_ok, stamped) quase sempre já foram ditas na hora pelo
    // social (city/social.ts e visit-social.ts as tiram daqui); chegando tarde, viram este aviso.
    case 'daily_limit':
      return tr('Daily limit reached: more tomorrow.');
    case 'already_done':
      return tr('You already did that today.');
    case 'reported':
      return tr('Report sent. Thanks: the moderators will take a look.');
    case 'blocked_ok':
      return tr('Blocked: you no longer see each other.');
    case 'stamped':
      return tr('Stamp left at the front desk.');
    default:
      void (id satisfies never);
      return tr('Notice from Habblaud World.');
  }
}
