// The text of each notice from the world server in the scene (`notice {level, text}`): the `text` is an id from the
// protocol's NOTICE_IDS, translated here (the server never sends sentences). Some ids say different things depending
// on where I am: on the street, waiting for the answer to an `enter` (at the door) or inside a building (put outside).
import { tr } from '../../../../shared/i18n';
import type { NoticeId } from '../../../../shared/world/protocol';

/** Where the notice arrived: on the street, right after an `enter` (the door) or inside a building. */
export type NoticePlace = 'street' | 'door' | 'inside';

/**
 * Text of a `notice` (the `text` is an id from the protocol's NOTICE_IDS, translated here; an unknown id becomes a
 * generic notice). null = nothing to show (ids that only matter to whoever debugs). A new id in the protocol without
 * a `case` here does not compile.
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
    // Phase 5 (light social). The confirmations (reported, blocked_ok, stamped) have almost always been said on the spot
    // by the social (city/social.ts and visit-social.ts take them from here); arriving late, they become this notice.
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
