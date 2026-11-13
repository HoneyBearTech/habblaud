// Input: drag (mouse/touch), wheel/pinch (zoom at the cursor), click/double click and keyboard.
import type { Camera } from './camera';

export type Hit = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface InputHandlers {
  pick(sx: number, sy: number): Hit;
  /** Click (or tap) without dragging: what was touched and where (CSS px of the canvas). */
  click(hit: Hit, at: { x: number; y: number }): void;
  doubleClick(hit: Hit): void;
  hover(sx: number, sy: number, inside: boolean): void;
  /** The user moved the camera (cancels "follow"). */
  interact(): void;
  overview(): void;
  zoomStep(steps: number, sx?: number, sy?: number): void;
  /** (Optional) Is the office on screen? With the city scene open, the keyboard does not move the hidden camera. */
  active?(): boolean;
  /** (Optional) Does the keyboard move the camera? (In the visit, the arrows and WASD walk the visitor.) Default: yes. */
  keys?(): boolean;
}

const DRAG_THRESHOLD = 5;
const PAN_KEY_STEP = 90;

/** Is there a modal dialog/popover open, or is the keyboard focus inside one? */
export function modalOpen(target: HTMLElement | null): boolean {
  if (target?.closest?.('dialog, [popover], [role="dialog"], [aria-modal="true"]')) return true;
  if (typeof document === 'undefined') return false;
  // A closed <dialog> stays in the DOM (with whatever attributes it has): only the open one counts.
  if (document.querySelector('dialog[open], :not(dialog)[aria-modal="true"]')) return true;
  try {
    return !!document.querySelector(':popover-open');
  } catch {
    // browser without support for :popover-open
    return false;
  }
}

export function attachInput(canvas: HTMLCanvasElement, camera: Camera, h: InputHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let downX = 0;
  let downY = 0;
  let dragging = false;
  let pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
  let wheelAcc = 0;
  let wheelSettle: ReturnType<typeof setTimeout> | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    if (pointers.size === 1) {
      downX = p.x;
      downY = p.y;
      dragging = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: camera.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      dragging = true;
      h.interact();
    }
  };

  const onMove = (e: PointerEvent) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') h.hover(p.x, p.y, true);
      return;
    }
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      camera.panBy(cx - pinch.cx, cy - pinch.cy);
      camera.zoomAt(pinch.zoom * (dist / pinch.dist), cx, cy, Date.now(), false);
      pinch.cx = cx;
      pinch.cy = cy;
      return;
    }
    if (!dragging && Math.hypot(p.x - downX, p.y - downY) > DRAG_THRESHOLD) {
      dragging = true;
      canvas.style.cursor = 'grabbing';
      h.interact();
    }
    if (dragging) camera.panBy(p.x - prev.x, p.y - prev.y);
  };

  const onUp = (e: PointerEvent) => {
    const p = local(e);
    const had = pointers.delete(e.pointerId);
    if (!had) return;
    if (pinch && pointers.size < 2) {
      pinch = null;
      camera.settle(Date.now());
      return;
    }
    if (pointers.size > 0) return;
    canvas.style.cursor = 'grab';
    if (dragging) {
      dragging = false;
      return;
    }
    const hit = h.pick(p.x, p.y);
    if (e.pointerType !== 'mouse') {
      // double tap
      const now = performance.now();
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
        h.doubleClick(hit);
        lastTap = { t: 0, x: 0, y: 0 };
        return;
      }
      lastTap = { t: now, x: p.x, y: p.y };
    }
    h.click(hit, p);
  };

  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      dragging = false;
      canvas.style.cursor = 'grab';
    }
  };

  const onLeave = () => h.hover(0, 0, false);

  const onDbl = (e: MouseEvent) => {
    const p = local(e);
    h.doubleClick(h.pick(p.x, p.y));
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    h.interact();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (e.ctrlKey) {
      // trackpad pinch: continuous zoom, snaps to a sharp level when it stops
      camera.zoomAt(camera.zoom * Math.exp(-delta * 0.012), p.x, p.y, Date.now(), false);
      if (wheelSettle) clearTimeout(wheelSettle);
      wheelSettle = setTimeout(() => camera.settle(Date.now()), 180);
      return;
    }
    wheelAcc += delta;
    if (Math.abs(wheelAcc) >= 50) {
      h.zoomStep(wheelAcc < 0 ? 1 : -1, p.x, p.y);
      wheelAcc = 0;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (h.active && !h.active()) return;
    if (h.keys && !h.keys()) return;
    const t = e.target as HTMLElement | null;
    // Field or radio in focus (replay speed): the arrows belong to the control, not the camera.
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute?.('role') === 'radio')) return;
    // modal/popover open (help, settings...): the keyboard belongs to it, not the camera
    if (modalOpen(t)) return;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        dx = PAN_KEY_STEP;
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        dx = -PAN_KEY_STEP;
        break;
      case 'ArrowUp':
      case 'w':
      case 'W':
        dy = PAN_KEY_STEP;
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        dy = -PAN_KEY_STEP;
        break;
      case '+':
      case '=':
        h.zoomStep(1);
        e.preventDefault();
        return;
      case '-':
      case '_':
        h.zoomStep(-1);
        e.preventDefault();
        return;
      case '0':
        h.overview();
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    h.interact();
    camera.panBy(dx, dy);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('dblclick', onDbl);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    if (wheelSettle) clearTimeout(wheelSettle);
  };
}
