// Notifications (opt-in): the browser's Notification for alerts with the tab hidden, alert sounds
// ("needs you" bell, completion click; through the UI's sound board) and the counter in the tab
// title when there are agents waiting for you.
import type { Notice } from '../../../shared/types';
import type { SoundBoard } from '../audio/board';
import type { UiComponent, UiContext } from './context';
import { computeCounters } from './model';
import { tr } from '../../../shared/i18n';

const BASE_TITLE = 'Habblaud';

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export class Notifier implements UiComponent {
  private lastTitle = '';

  constructor(
    private ctx: UiContext,
    private sounds: SoundBoard,
  ) {
    ctx.store.on('notice', (n) => this.onNotice(n));
  }

  /** Asks for notification permission when the option is turned on. Returns the final state. */
  async enableBrowserNotifications(): Promise<NotificationState> {
    const state = notificationState();
    if (state === 'unsupported' || state === 'denied' || state === 'granted') return state;
    try {
      return await Notification.requestPermission();
    } catch {
      return notificationState();
    }
  }

  render(): void {
    // Live, even during the timelapse: the tab title tells who needs you now.
    const waiting = computeCounters(this.ctx.store.liveSnapshot).waiting;
    const title = waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      document.title = title;
    }
  }

  private onNotice(n: Notice): void {
    const prefs = this.ctx.prefs;
    // the bell rings even with the tab hidden (it is what calls you back); the click, only with it in view
    if (n.level === 'alert') this.sounds.play('chime');
    else if (n.level === 'success') this.sounds.play('pop');
    if (n.level === 'alert' && prefs.browserNotifications && document.hidden && notificationState() === 'granted') {
      try {
        const notification = new Notification(tr('Habblaud — needs you'), {
          body: n.text,
          tag: n.agentId ?? n.id,
          icon: '/assets/brand/favicon-32.png',
        });
        notification.onclick = () => {
          window.focus();
          if (n.agentId && this.ctx.agent(n.agentId)) this.ctx.select({ type: 'agent', id: n.agentId }, { focus: true });
          notification.close();
        };
      } catch {
        // Some browsers only allow notifications through a service worker; the toast still shows up.
      }
    }
  }
}
