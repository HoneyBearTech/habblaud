// Messages from the office (POST /api/messages): what the server, the demo and the page have in common.
// Pure code: no Node or DOM APIs.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';

/** Maximum size of a message (characters). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` of the "Message via Habblaud" activity (it is not a tool of the agent: it is your text going in). */
export const MESSAGE_TOOL = 'HabblaudMessage';
/** Detail of the activity: the start of the text, masked and cut (the whole text goes only to the session). */
const DETAIL_MAX = 300;

/**
 * "Message via Habblaud" activity of a message delivered to the session (it went into it or into its queue: it
 * doesn't mean the agent has read it yet).
 */
export function describeMessage(text: string): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  return { kind: 'communicate', icon: '✉️', text: tr('Message via Habblaud'), tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}
