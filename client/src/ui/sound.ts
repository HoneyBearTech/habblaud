// Interface sounds (opt-in): connects the sound board to the preferences, plays the ambient sounds that the
// world suggests (keyboard, elevator, hangouts) and unlocks audio on the user's first gesture.
import { SoundBoard } from '../audio/board';
import type { SoundKind } from '../audio/scheduler';
import type { UiComponent, UiContext } from './context';

export class SoundControl implements UiComponent {
  readonly board = new SoundBoard();
  private previewAt = 0;

  constructor(private ctx: UiContext) {
    this.sync();
    ctx.world.onSound?.((cue) => this.board.play(cue.kind, cue));
    // The browser only unlocks audio after a user gesture.
    const unlock = () => {
      if (this.ctx.prefs.sound) void this.board.unlock();
    };
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
  }

  render(): void {
    this.sync();
  }

  /** Applies the current preferences (main switch, volume, categories). */
  sync(): void {
    this.board.configure(this.ctx.prefs.sound, this.ctx.prefs.sounds);
  }

  /** Sample when changing the settings (called from the click: unlocks audio). */
  preview(kind: SoundKind = 'pop'): void {
    this.sync();
    const now = performance.now();
    const ready = this.board.unlock();
    if (now - this.previewAt < 250) return;
    this.previewAt = now;
    // the first "resume" of the AudioContext is asynchronous
    void ready.then(() => this.board.play(kind));
  }
}
