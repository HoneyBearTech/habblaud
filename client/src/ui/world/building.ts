// Cartão "Seu prédio" (a janela do Habblaud World, conta aprovada) e a janela "Ver o que foi enviado".
//
// O cartão mostra a conexão, a pausa, a parada pedida pelo servidor do mundo (com o motivo) e "Fora do mundo"; o botão
// "Sair do mundo" pede confirmação em dois cliques, como o "Sair da conta", e explica a diferença para a pausa. Fase 6:
// conta suspensa ou banida ganha "Recorrer por e-mail" (mailto com o id da conta no assunto, quando se sabe), o prédio
// "não verificado" mostra o selo com "Contestar por e-mail", e a manutenção do mundo aparece no lugar do "Reconectando".
// O cartão é atualizado no lugar a cada render (contagens e "última remessa" mudam a cada poucos segundos sem refazer a
// tela inteira, que perderia o foco). A janela mostra a última remessa exatamente como o servidor local a guardou
// (GET /api/world/last-uplink): o JSON, o horário, o tamanho em bytes e a resposta do mundo. As regras e os textos
// estão em world-model.ts (buildingView, ackView).
import { tr } from '../../../../shared/i18n';
import type { WorldBuildingStatus, WorldClient, WorldLastUplink } from '../../net/world';
import { copyText, h, iconButton, setAttr, setHidden, setText, setVariant } from '../dom';
import { formatClock, relativeTime } from '../format';
import { ICONS } from '../icons';
import { BuildingSocial } from './away-summary';
import { extLink, WORLD_PRIVACY_URL } from './links';
import { ackView, appealMailto, buildingView, bytesText, leaveHint, prettyUplink, worldErrorText } from './world-model';

export interface BuildingHost {
  readonly client: WorldClient | null;
  /** O prédio segundo o último status (ou o snapshot, antes dele). */
  building(): WorldBuildingStatus | undefined;
  hasPlayer(): boolean;
  /** Relê o status (depois de pausar ou retomar). */
  refresh(): void;
  /** Abre a janela "Ver o que foi enviado". */
  openSent(opener: HTMLElement): void;
  /** "Ver como os outros veem": entra no próprio prédio pela cidade (null: a cena Mundo não está disponível aqui). */
  visitOwn?(): (() => void) | null;
  now(): number;
  /** O id da conta no mundo, se o servidor local já sabe (vai no assunto do recurso). */
  accountId?(): string | undefined;
  /** O mundo está em manutenção (o último status veio com `maintenance`). */
  maintenance?(): boolean;
}

export class BuildingCard {
  readonly el: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly desc: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly rejected: HTMLElement;
  private readonly rejectedReason: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly sentBtn: HTMLButtonElement;
  private readonly visitBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly error: HTMLElement;
  private readonly leaveRow: HTMLElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly unverified: HTMLElement;
  private readonly appealRow: HTMLElement;
  private readonly appealLink: HTMLAnchorElement;
  private readonly appealHint: HTMLElement;
  /** Fase 5: o código do prédio e o "Enquanto você estava fora". */
  private readonly social: BuildingSocial;
  private statsKey = '';
  private busy = false;
  private action: 'pause' | 'resume' | 'join' | null = null;
  /** Primeiro clique em "Sair do mundo" dado: o segundo confirma. */
  private confirmingLeave = false;

  constructor(private readonly host: BuildingHost) {
    const titleId = 'ui-world-building-title';
    this.badge = h('span', { class: 'ui-world__bstate' });
    this.desc = h('p', { class: 'ui-world__bdesc' });
    this.stats = h('ul', { class: 'ui-world__bstats', attrs: { 'aria-label': tr('Your building now') } });
    this.rejectedReason = h('span');
    this.rejected = h('p', { class: 'ui-world__brejected', role: 'status', hidden: true }, h('strong', { text: tr('The world rejected the last upload.') }), ' ', this.rejectedReason);
    this.toggleBtn = h('button', { class: 'ui-btn', type: 'button', on: { click: () => void this.toggle() } });
    this.sentBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('See what was sent'), attrs: { 'aria-haspopup': 'dialog' }, on: { click: () => host.openSent(this.sentBtn) } });
    this.visitBtn = h('button', {
      class: 'ui-btn',
      type: 'button',
      text: `👁 ${tr('See it as others do')}`,
      title: tr('Enter your building through the city and see what visitors see (nothing from your real office)'),
      hidden: true,
      on: { click: () => host.visitOwn?.()?.() },
    });
    this.actions = h('div', { class: 'ui-world__actions' }, this.toggleBtn, this.sentBtn, this.visitBtn);
    this.hint = h('p', { class: 'ui-set__hint' });
    this.error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    this.leaveBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Leave the world'), on: { click: () => void this.leave() } });
    this.leaveRow = h('div', { class: 'ui-world__leave' }, h('p', { class: 'ui-set__hint', text: leaveHint() }), h('div', { class: 'ui-world__actions' }, this.leaveBtn));
    this.unverified = h('p', { class: 'ui-world__unverified', role: 'status', hidden: true });
    this.appealLink = h('a', { class: 'ui-btn', attrs: { href: appealMailto() } });
    this.appealHint = h('span', { class: 'ui-set__hint' });
    this.appealRow = h('div', { class: 'ui-world__appeal', hidden: true }, this.appealHint, h('div', { class: 'ui-world__actions' }, this.appealLink));
    this.social = new BuildingSocial({ client: host.client, building: () => host.building(), refresh: () => host.refresh() });
    this.el = h(
      'section',
      { class: 'ui-world__building', attrs: { 'aria-labelledby': titleId } },
      h(
        'div',
        { class: 'ui-world__bhead' },
        h('span', { class: 'ui-world__bart', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'ui-world__btitle' }, h('h4', { text: tr('Your building'), attrs: { id: titleId } }), this.badge),
      ),
      this.desc,
      this.unverified,
      this.stats,
      this.social.el,
      this.rejected,
      this.appealRow,
      this.actions,
      this.hint,
      this.leaveRow,
      this.error,
    );
    this.sync();
  }

  /** Atualiza no lugar (barato: só mexe no que mudou). */
  sync(): void {
    const v = buildingView(this.host.building(), this.host.hasPlayer(), this.host.now(), { maintenance: this.host.maintenance?.() });
    setVariant(this.el, 'is-', v.state);
    setText(this.badge, v.label);
    setText(this.desc, v.desc);
    const key = v.stats.join('\n');
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.stats.replaceChildren(...v.stats.map((t) => h('li', { text: t })));
    }
    setHidden(this.stats, !v.stats.length);
    setHidden(this.rejected, !v.rejected);
    setText(this.rejectedReason, v.rejected ?? '');
    // "Ver o que foi enviado" fica sempre (sem personagem, nada saiu: a janela diz isso); o botão de pausa, só quando há.
    setHidden(this.toggleBtn, !v.toggle);
    setHidden(this.hint, !v.toggle);
    if (v.toggle && !this.busy) {
      this.action = v.toggle.action;
      setText(this.toggleBtn, v.toggle.text);
      setText(this.hint, v.toggle.hint);
    }
    // o próprio prédio, como os outros veem: com o prédio no mundo (aceso ou pausado) e a cena Mundo disponível
    setHidden(this.visitBtn, !(v.state === 'connected' || v.state === 'paused' || v.state === 'reconnecting') || !this.host.visitOwn?.());
    setHidden(this.leaveRow, !v.leave);
    if (!v.leave && this.confirmingLeave) this.resetLeave();
    setText(this.unverified, v.unverified ?? '');
    setHidden(this.unverified, !v.unverified);
    setHidden(this.appealRow, !v.appeal);
    if (v.appeal) {
      setText(this.appealLink, v.appeal.text);
      setText(this.appealHint, v.appeal.hint);
      setAttr(this.appealLink, 'href', appealMailto(this.host.accountId?.()));
    }
    this.social.sync();
  }

  private resetLeave(): void {
    this.confirmingLeave = false;
    setText(this.leaveBtn, tr('Leave the world'));
    this.leaveBtn.classList.remove('is-danger');
  }

  /** "Sair do mundo" em dois cliques: o primeiro pede confirmação, o segundo retira o prédio. */
  private async leave(): Promise<void> {
    const client = this.host.client;
    if (this.busy || !client) return;
    if (!this.confirmingLeave) {
      this.confirmingLeave = true;
      setText(this.leaveBtn, tr('Confirm: leave the world'));
      this.leaveBtn.classList.add('is-danger');
      return;
    }
    this.busy = true;
    this.leaveBtn.disabled = true;
    this.toggleBtn.disabled = true;
    setAttr(this.leaveBtn, 'aria-busy', 'true');
    setHidden(this.error, true);
    const r = await client.leave();
    this.busy = false;
    this.leaveBtn.disabled = false;
    this.toggleBtn.disabled = false;
    setAttr(this.leaveBtn, 'aria-busy', null);
    this.resetLeave();
    if (!r.ok) {
      setText(this.error, worldErrorText(r.code, 'leave'));
      setHidden(this.error, false);
    }
    this.host.refresh();
  }

  private async toggle(): Promise<void> {
    const client = this.host.client;
    const action = this.action;
    if (this.busy || !client || !action) return;
    this.busy = true;
    this.toggleBtn.disabled = true;
    setAttr(this.toggleBtn, 'aria-busy', 'true');
    setHidden(this.error, true);
    const r = action === 'pause' ? await client.pause() : action === 'join' ? await client.join() : await client.resume();
    this.busy = false;
    this.toggleBtn.disabled = false;
    setAttr(this.toggleBtn, 'aria-busy', null);
    if (!r.ok) {
      setText(this.error, worldErrorText(r.code, action));
      setHidden(this.error, false);
    }
    this.host.refresh();
  }
}

/**
 * Janela "Ver o que foi enviado". Fica dentro da janela do Habblaud World (um <dialog> dentro de outro): aberta como
 * modal, ela sobe para o topo da top layer sem fechar a do World, e Esc ou um clique fora fecham só ela.
 */
export class SentDialog {
  readonly el: HTMLDialogElement;
  private readonly body: HTMLElement;
  private req = 0;
  private opener: HTMLElement | null = null;

  constructor(
    private readonly client: () => WorldClient | null,
    private readonly now: () => number,
  ) {
    const titleId = 'ui-world-sent-title';
    this.body = h('div', { class: 'ui-world-sent__content' });
    const close = iconButton(ICONS.close, tr('Close'), () => this.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-world-sent', attrs: { 'aria-labelledby': titleId } },
      h(
        'div',
        { class: 'ui-world-sent__body' },
        h('div', { class: 'ui-world-sent__head' }, h('h2', { class: 'ui-world-sent__title', text: tr('What was sent'), attrs: { id: titleId } }), close),
        this.body,
      ),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('close', () => {
      this.req++;
      this.opener?.focus();
      this.opener = null;
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  async open(opener?: HTMLElement): Promise<void> {
    this.opener = opener ?? null;
    if (!this.el.open) {
      try {
        this.el.showModal();
      } catch {
        this.el.setAttribute('open', '');
      }
    }
    await this.load();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  private async load(): Promise<void> {
    const client = this.client();
    if (!client) return;
    const req = ++this.req;
    this.body.replaceChildren(h('p', { class: 'ui-set__hint', text: tr('Loading…') }));
    const r = await client.lastUplink();
    if (req !== this.req) return;
    if (!r.ok) {
      const retry = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Try again'), on: { click: () => void this.load() } });
      this.body.replaceChildren(h('p', { class: 'ui-world__error', role: 'alert', text: worldErrorText(r.code, 'sent') }), h('div', { class: 'ui-world__actions' }, retry));
      return;
    }
    this.body.replaceChildren(...(r.data ? this.sent(r.data) : this.nothing()));
  }

  private nothing(): Node[] {
    return [
      h('p', { class: 'ui-world-sent__lead', text: tr('Nothing has left this computer yet: the building joins the world with the first upload.') }),
      h('p', { class: 'ui-set__hint' }, extLink(tr('What can leave and what never does'), WORLD_PRIVACY_URL)),
    ];
  }

  private sent(last: WorldLastUplink): Node[] {
    const json = prettyUplink(last.uplink);
    const ack = ackView(last.ack, last.bytes);
    const copy = h('button', { class: 'ui-btn', type: 'button', text: tr('Copy') });
    let timer: ReturnType<typeof setTimeout> | undefined;
    copy.addEventListener('click', async () => {
      const ok = await copyText(json);
      setText(copy, ok ? tr('Copied!') : tr("Couldn't copy"));
      clearTimeout(timer);
      timer = setTimeout(() => setText(copy, tr('Copy')), 1600);
    });
    const ackEl = h(
      'p',
      { class: `ui-world-sent__ack is-${ack.kind}` },
      h('strong', { text: ack.label }),
      ack.reason ? ' ' : null,
      ack.reason,
    );
    return [
      h(
        'ul',
        { class: 'ui-world-sent__meta' },
        h('li', { text: tr('Sent {0} ({1})', [relativeTime(last.at, this.now()), formatClock(last.at)]) }),
        h('li', { text: bytesText(last.bytes) }),
      ),
      ackEl,
      h(
        'p',
        { class: 'ui-world-sent__lead' },
        tr('This is everything that left your computer. No paths, project names, text or office times.'),
        ' ',
        extLink(tr('What can leave and what never does'), WORLD_PRIVACY_URL),
      ),
      h('pre', { class: 'ui-world-sent__json', tabIndex: 0, text: json, attrs: { 'aria-label': tr('Sent packet (JSON)') } }),
      h('div', { class: 'ui-world__actions' }, copy, h('button', { class: 'ui-btn', type: 'button', text: tr('Close'), on: { click: () => this.close() } })),
    ];
  }
}
