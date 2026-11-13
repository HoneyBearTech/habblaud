// Habblaud interface (DOM panels over the office canvas).
// Receives the OfficeStore (data) and the WorldApi (canvas) and builds: top bar with usage per account,
// sidebar, details drawer, feed, notices, settings, help and loading/empty states.
// Incremental DOM: the snapshots (up to ~5/s) only mark the UI as "dirty"; everything is reconciled once per frame.
import { access, onAccessChange } from '../net/access';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';

import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { PanelName, TerminalRouter, UiComponent, UiContext } from './context';
import { DayLauncher } from './daystats-launcher';
import { RoomRenamer } from './roomrename';
import { h } from './dom';
import { Drawer } from './drawer';
import { FeedPanel } from './feed';
import { HelpDialog } from './help';
import { HistoryPopover } from './history';
import { Deliveries } from './deliveries';
import { HoverTip } from './hovertip';
import { hasRunningShells } from './model';
import { hasCodexPermission } from './provider';
import { Notifier } from './notify';
import { ConnectionBanner, EmptyState, Splash } from './overlays';
import { focusPermission, nextPermissionAgent } from './permission';
import { loadPrefs, safeLocalStorage, savePrefs, worldOptionsFrom, type UiPrefs } from './prefs';
import { SettingsPopover } from './settings';
import { Sidebar } from './sidebar';
import { SoundControl } from './sound';
import { TERMINAL_UNAVAILABLE_HINT, TerminalPanel } from './terminal';
import { PtyPanel } from './pty';
import { TimelapsePlayer } from './timelapse';
import { Toasts } from './toasts';
import { UpdateToaster } from './version';
import { TopBar } from './topbar';
import { UpdateBanner } from './update';
import { WorldPopups } from './world/world-popups';
import { WorldChip } from './world/world-chip';
import { WorldDialog } from './world/world-dialog';
import { WorldSocialNotifier } from './world/away-summary';
import { worldGate } from './world/settings-world';
import { worldSectionMode } from './world/world-model';
import { SceneSwitch, type CitySceneHost } from './world/scene-switch';
import { worldSource } from '../net/world';
import { FreeArea } from './viewport';
import { tr } from '../../../shared/i18n';

/** Clock for the relative times ("5 s ago"). */
const CLOCK_MS = 5_000;
/** Clock for the shell stopwatch ("12:31") and for the deadline of Codex requests, on only while one of the two exists. */
const SHELL_CLOCK_MS = 1_000;
const NARROW_QUERY = '(max-width: 900px)';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export function createUI(root: HTMLElement, store: OfficeStore, world: WorldApi, city?: CitySceneHost): void {
  const storage = safeLocalStorage();
  let prefs: UiPrefs = loadPrefs(storage);
  let selection: Selection = world.getSelection();
  let skew = 0;
  const narrowMq = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
  const panels: Record<PanelName, boolean> = {
    sidebar: narrowMq?.matches ? false : prefs.sidebarOpen,
    feed: narrowMq?.matches ? false : prefs.feedOpen,
  };

  const live = h('div', { class: 'ui-sr', role: 'status', attrs: { 'aria-live': 'polite' } });

  let topbar: TopBar;
  let sidebar: Sidebar;
  let drawer: Drawer;
  let settings: SettingsPopover;
  let worldDialog: WorldDialog;
  let help: HelpDialog;
  let area: FreeArea;
  let timelapse: TimelapsePlayer;
  /** The selection in progress came from the UI (list, feed, notice...), not from a click on the canvas. */
  let uiSelecting = false;
  /** World button and the trip to the city and back (only when app.ts builds the scene). */
  let scene: SceneSwitch | null = null;
  const inCity = () => !!scene?.inCity;

  const ctx: UiContext = {
    store,
    world,
    root,
    get prefs() {
      return prefs;
    },
    updatePrefs(patch) {
      prefs = { ...prefs, ...patch };
      savePrefs(storage, prefs);
      world.setOptions(worldOptionsFrom(prefs));
      invalidate();
    },
    now: () => timelapse?.replayTime ?? Date.now() + skew,
    account: (id) => store.snapshot?.accounts.find((a) => a.id === id),
    agent: (id) => store.agent(id),
    selection: () => selection,
    select(sel, opts) {
      // In the city the office (drawer, terminal) is hidden: choosing an agent or room goes back to it. Before
      // anything else: the free area only measures the drawer and the sidebar without the `is-city` class.
      scene?.leaveFor(sel);
      if (sel && opts?.focus) area.setIntent(sel);
      else area.clearIntent();
      // The drawer starts counting in the free area BEFORE the focus: the world centers right away on the visible part.
      const prev = selection;
      selection = sel;
      area.selectingFromUi();
      applyLayout({ refocus: false });
      uiSelecting = true;
      try {
        world.select(sel, opts);
      } catch (err) {
        selection = prev;
        applyLayout();
        throw err;
      } finally {
        uiSelecting = false;
      }
    },
    focusSelection() {
      if (selection) ctx.select(selection, { focus: true });
    },
    camera(action) {
      if (inCity() && city) {
        if (action === 'overview') city.recenter();
        else city.zoomBy(action === 'zoomIn' ? 1.25 : 1 / 1.25);
        return;
      }
      area.clearIntent();
      if (action === 'overview') world.overview();
      else world.zoomBy(action === 'zoomIn' ? 1.25 : 1 / 1.25);
    },
    invalidate: () => invalidate(),
    togglePanel(name, open) {
      const next = open ?? !panels[name];
      if (panels[name] === next) return;
      panels[name] = next;
      if (!ctx.isNarrow()) ctx.updatePrefs(name === 'sidebar' ? { sidebarOpen: next } : { feedOpen: next });
      applyLayout();
      invalidate();
    },
    isPanelOpen: (name) => panels[name],
    isNarrow: () => !!narrowMq?.matches,
    announce(text) {
      live.textContent = '';
      requestAnimationFrame(() => (live.textContent = text));
    },
    focusSearch() {
      if (!panels.sidebar) ctx.togglePanel('sidebar', true);
      requestAnimationFrame(() => sidebar.focusSearch());
    },
    openHelp: (section) => help.open(section),
    toggleSettings: () => settings.toggle(topbar.settingsBtn),
    toggleWorld: () => worldDialog.toggle(topbar.worldBtn),
    openAbout: () => settings.showAbout(topbar.settingsBtn),
    toggleTimelapse() {
      // The terminal shows the conversation of right now: it does not go with the replayed day.
      if (!timelapse.isOpen && terminal.isOpen) terminal.close();
      timelapse.toggle();
    },
    isTimelapseOpen: () => timelapse.isOpen,
  };

  // ---------------------------------------------------------------- components
  const sound = new SoundControl(ctx);
  const notifier = new Notifier(ctx, sound.board);
  topbar = new TopBar(ctx);
  sidebar = new Sidebar(ctx);
  // Interactive terminal (real Claude Code, inside the browser): open, take over and end sessions.
  const pty = new PtyPanel(ctx);
  const terminal = new TerminalPanel(ctx, pty);
  // Session history (terminal): button in the panels group of the top bar.
  const history = new HistoryPopover(ctx, terminal);
  topbar.panelGroup.prepend(history.button);
  // Agent's terminal: the interactive one if the session runs here; otherwise the read-only one, with "Take over here"
  // to continue in this window (without the read-only one, the interactive one shows the "in another terminal" notice).
  pty.onShow = () => terminal.close();
  const router: TerminalRouter = {
    get openAgentId() {
      return pty.isOpen ? pty.agentId : terminal.agentId;
    },
    get available() {
      return pty.enabled || (!!store.snapshot?.meta.terminal && !store.replaying);
    },
    interactive: (id) => !!pty.ptyOf(id),
    get interactiveEnabled() {
      return pty.enabled;
    },
    newSession: (cwd, account) => pty.newSession(cwd, account),
    open(id, opener) {
      const readOnly = !!store.snapshot?.meta.terminal && !store.replaying;
      if (pty.ptyOf(id) || (pty.enabled && !readOnly && ctx.agent(id)?.kind === 'main')) pty.openAgent(id);
      else {
        pty.close();
        terminal.open(id, opener);
      }
    },
    toggle(id, opener) {
      if (router.openAgentId === id) {
        pty.close();
        terminal.close();
      } else router.open(id, opener);
    },
  };
  ctx.terminals = router;
  // Deliveries: what the agents finished (first button of the group: it is the one used most from the phone).
  const deliveries = new Deliveries(ctx, terminal);
  topbar.panelGroup.prepend(deliveries.button);
  // Links with ?agent= / ?delivery= (they open the agent or the delivery on load).
  const openLink = (url: URL) => {
    const agent = url.searchParams.get('agent');
    const delivery = url.searchParams.get('delivery');
    if (!agent && !delivery) return;
    const go = () => {
      if (delivery) void deliveries.openById(delivery);
      else if (agent && ctx.agent(agent)) ctx.select({ type: 'agent', id: agent }, { focus: true });
    };
    if (store.snapshot) go();
    else {
      const off = store.on('snapshot', () => {
        off();
        setTimeout(go, 300);
      });
    }
    if (url.search && location.search === url.search) window.history.replaceState(null, '', location.pathname);
  };
  if (typeof location !== 'undefined') openLink(new URL(location.href));
  drawer = new Drawer(ctx, terminal, pty);
  const feed = new FeedPanel(ctx);
  const toasts = new Toasts(ctx);
  const updateToaster = new UpdateToaster(ctx, (n) => toasts.push(n));
  // Habblaud World (in development): its own window (button in the top bar) and the launch popups, only with
  // meta.world on. Settings only gets from it the theme hint in Appearance.
  const hw = worldSource(store);
  worldDialog = new WorldDialog(ctx, hw, topbar.worldBtn);
  settings = new SettingsPopover(ctx, notifier, sound, worldDialog);
  const popups = new WorldPopups(ctx, hw, { openWorld: (screen) => worldDialog.show(screen, topbar.worldBtn), panelOpen: () => settings.isOpen || worldDialog.isOpen });
  // "🏙️ in the world" / "⏸ paused" chip in the top bar (approved account; never through the phone port).
  const worldChip = new WorldChip(ctx, hw, () => worldDialog.show('home'), (n) => toasts.push(n));
  topbar.addStatus(worldChip.el);
  // "While you were away" on connect and the notice of who knocked on the door (Phase 5; only from the computer itself).
  const worldSocial = new WorldSocialNotifier(ctx, hw, {
    active: () => worldSectionMode(hw.meta(), worldGate(ctx, hw)) === 'active',
    toast: (n) => toasts.push(n),
    openWorld: () => worldDialog.show('home'),
  });
  // World button: swaps the office for the city (the scene comes from app.ts, loaded on demand).
  if (city) {
    scene = new SceneSwitch(ctx, hw, city, () => {
      const on = inCity();
      root.classList.toggle('is-city', on);
      if (on) {
        if (terminal.isOpen) terminal.close();
        if (pty.isOpen) pty.close();
        if (ctx.isNarrow() && panels.sidebar) ctx.togglePanel('sidebar', false);
      }
      invalidate();
    });
    topbar.addSceneButton(scene.button);
    const sw = scene;
    ctx.visitOwnBuilding = () => {
      if (worldDialog.isOpen) worldDialog.close();
      if (settings.isOpen) settings.hide();
      void sw.visitOwn();
    };
  }
  help = new HelpDialog();
  const day = new DayLauncher(ctx, (el) => root.append(el));
  topbar.addPanelButton(day.button);
  // Right-click on a room (side list or office): rename.
  const renamer = new RoomRenamer(ctx);
  ctx.renameRoom = (id, at) => renamer.open(id, at);
  world.onRoomContextMenu?.((id, at) => renamer.open(id, at));
  const empty = new EmptyState(ctx);
  const banner = new ConnectionBanner(ctx);
  const update = new UpdateBanner(store);
  const tip = new HoverTip(ctx);
  const splash = new Splash(ctx);
  timelapse = new TimelapsePlayer(ctx);
  const scrim = h('div', { class: 'ui-scrim', attrs: { 'aria-hidden': 'true' }, on: { click: () => ctx.togglePanel('sidebar', false) } });

  root.classList.add('ui-root');
  root.append(timelapse.vignette, topbar.el, sidebar.el, scrim, feed.el, drawer.el, terminal.el, pty.el, timelapse.el, timelapse.badge, toasts.el, banner.el, update.el, empty.el, popups.el, tip.el, settings.el, worldDialog.el, history.el, deliveries.el, help.el, renamer.el, live, splash.el);
  area = new FreeArea(world, { root, topbar: topbar.el, sidebar: sidebar.el, drawer: drawer.el, feed: feed.el }, () => ({
    sidebar: panels.sidebar,
    feed: panels.feed,
    drawer: selection !== null && !drawer.floating,
    narrow: ctx.isNarrow(),
  }));
  drawer.onLayoutChange = () => applyLayout();

  const components: UiComponent[] = [topbar, sidebar, drawer, terminal, pty, history, deliveries, feed, toasts, settings, empty, banner, tip, notifier, splash, timelapse, sound, day, updateToaster, worldDialog, popups, worldChip];
  if (scene) components.push(scene);
  root.append(worldSocial.el);
  components.push(worldSocial);

  // ---------------------------------------------------------------- rendering batched per frame
  let rafId = 0;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function renderAll(): void {
    rafId = 0;
    for (const c of components) {
      try {
        c.render();
      } catch (err) {
        console.error('[ui] failed to render', c.constructor.name, err);
      }
    }
  }

  function invalidate(): void {
    if (document.hidden) {
      // With the tab hidden the browser freezes rAF: keeps only the title and the alerts up to date.
      hiddenTimer ??= setTimeout(() => {
        hiddenTimer = null;
        notifier.render();
        toasts.render();
      }, 500);
      return;
    }
    if (!rafId) rafId = requestAnimationFrame(renderAll);
  }

  /** Applies the layout classes and tells the world the free area (without waiting for the panels' transitions). */
  function applyLayout(opts: { refocus?: boolean } = {}): void {
    root.classList.toggle('has-sidebar', panels.sidebar);
    root.classList.toggle('has-feed', panels.feed);
    root.classList.toggle('has-drawer', selection !== null && !drawer.floating);
    root.classList.toggle('is-narrow', ctx.isNarrow());
    area.sync(opts);
  }

  // ---------------------------------------------------------------- events
  store.on('snapshot', (snap) => {
    // Live, the interface's "now" follows the server's clock (the device may be fast or slow).
    // In the timelapse, the instant replayed by the player rules (stopped when paused).
    if (store.connection === 'open' && !store.replaying) skew = snap.serverTime - Date.now();
    invalidate();
  });
  store.on('connection', () => invalidate());
  onAccessChange(() => invalidate());
  world.onSelect((sel) => {
    const prev = selection;
    selection = sel;
    // Click on the canvas (or an agent that left): the drawer waits for the double-click window before moving the camera.
    if (!uiSelecting) area.selectionChangedExternally(prev, sel);
    applyLayout(uiSelecting ? { refocus: false } : {});
    invalidate();
  });
  narrowMq?.addEventListener('change', (e) => {
    if (e.matches) {
      panels.sidebar = false;
      panels.feed = false;
    } else {
      panels.sidebar = prefs.sidebarOpen;
      panels.feed = prefs.feedOpen;
    }
    applyLayout();
    invalidate();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) invalidate();
  });
  setInterval(() => {
    if (!document.hidden) invalidate();
  }, CLOCK_MS);
  setInterval(() => {
    // Shells running (stopwatch) or a Codex request waiting (deadline of seconds).
    if (!document.hidden && (hasRunningShells(store.snapshot) || hasCodexPermission(store.snapshot))) invalidate();
  }, SHELL_CLOCK_MS);

  addEventListener('keydown', (e) => onKey(e));

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // In the city the office shortcuts are off: Esc closes the open card or goes back to the office.
    if (inCity()) {
      if (e.key === 'Escape') {
        if (help.isOpen || settings.isOpen || worldDialog.isOpen || history.isOpen || document.querySelector('dialog[open], :not(dialog)[aria-modal="true"]')) return;
        e.preventDefault();
        if (!city?.escape()) scene?.close();
      } else if (e.key === '?' && !isTypingTarget(e.target) && !help.isOpen) {
        e.preventDefault();
        help.open();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (help.isOpen || settings.isOpen || worldDialog.isOpen || history.isOpen) return; // dialog/popover handle their own Esc
      // The terminal floats over everything: it closes first (its search, then itself; the drawer stays open).
      if (terminal.isOpen) {
        terminal.escape();
        e.preventDefault();
      } else if (ctx.isNarrow() && panels.sidebar) {
        ctx.togglePanel('sidebar', false);
        e.preventDefault();
      } else if (selection) {
        ctx.select(null);
        e.preventDefault();
      }
      return;
    }
    if (isTypingTarget(e.target) || help.isOpen || worldDialog.isOpen) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        ctx.focusSearch();
        break;
      case '?':
        e.preventDefault();
        help.open();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (selection?.type === 'agent') drawer.toggleFollow();
        else ctx.announce(tr('Select an agent to follow.'));
        break;
      case 't':
      case 'T':
        e.preventDefault();
        toggleTerminal();
        break;
      case 'l':
      case 'L':
        if (store.mock) break;
        e.preventDefault();
        ctx.toggleTimelapse();
        break;
      case 'p':
      case 'P': {
        // Next permission request or question to answer from the office (it only leads to it: never approves).
        e.preventDefault();
        const next = nextPermissionAgent(store.snapshot?.agents ?? [], selection?.type === 'agent' ? selection.id : undefined);
        if (next) focusPermission(ctx, next.id);
        else ctx.announce(tr('No permission requests or questions to answer right now.'));
        break;
      }
      case 'o':
      case 'O':
        e.preventDefault();
        ctx.camera('overview');
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        day.toggle();
        break;
      case '[':
        e.preventDefault();
        ctx.togglePanel('sidebar');
        break;
      case ']':
        e.preventDefault();
        ctx.togglePanel('feed');
        break;
    }
  }

  /**
   * T shortcut: opens the terminal window of the selected agent (see `router`) or closes the one that is open.
   */
  function toggleTerminal(): void {
    const id = selection?.type === 'agent' ? selection.id : null;
    if (id !== null && pty.enabled && ctx.agent(id)?.kind === 'main') return router.toggle(id);
    if (id === null && pty.isOpen) return pty.close();
    if (terminal.isOpen && (id === null || terminal.agentId === id)) terminal.close();
    else if (id === null) ctx.announce(tr('Select an agent to open the terminal.'));
    else if (!store.snapshot?.meta.terminal || !access().terminal) ctx.announce(`${TERMINAL_UNAVAILABLE_HINT}.`);
    else if (!ctx.agent(id)) ctx.announce(tr('The agent has already left the office.'));
    else terminal.open(id);
  }

  // ---------------------------------------------------------------- start
  world.setOptions(worldOptionsFrom(prefs));
  applyLayout();
  renderAll();
}
