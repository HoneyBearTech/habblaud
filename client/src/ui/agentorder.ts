// Order of each project's agents chosen by the user (by dragging the rows of the side list): a single order per
// project, kept in the browser by the Claude Code session (not by the process, which changes when a session resumes).
const ORDER_KEY = 'habblaud.tabs.order';
/** Remembered projects (the most recent). */
const MAX_ROOMS = 50;

type OrderMap = Record<string, string[]>;

/** Stored order first (by session); whoever is not in it goes to the end, in the order they came. */
export function orderAgents<T>(roomId: string, items: readonly T[], sessionOf: (item: T) => string): T[] {
  const saved = loadOrder()[roomId];
  if (!saved?.length) return items.slice();
  const rank = new Map(saved.map((sid, i) => [sid, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(sessionOf(item)) }))
    .sort((x, y) => (x.r ?? Infinity) - (y.r ?? Infinity) || x.i - y.i)
    .map((x) => x.item);
}

/** Puts `from` before (or after) `to` in `items` (already in the order shown) and saves the project's order. */
export function moveAgent<T>(roomId: string, items: readonly T[], idOf: (item: T) => string, sessionOf: (item: T) => string, from: string, to: string, after: boolean): boolean {
  const moved = items.find((a) => idOf(a) === from);
  const rest = items.filter((a) => idOf(a) !== from);
  const at = rest.findIndex((a) => idOf(a) === to);
  if (!moved || at < 0) return false;
  rest.splice(after ? at + 1 : at, 0, moved);
  saveOrder(roomId, rest.map(sessionOf));
  return true;
}

function loadOrder(): OrderMap {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // Only lists of sessions: a value in another format (edited by hand, another version) cannot break the side list.
    const map: OrderMap = {};
    for (const [room, ids] of Object.entries(v)) {
      if (Array.isArray(ids)) map[room] = ids.filter((x): x is string => typeof x === 'string');
    }
    return map;
  } catch {
    return {};
  }
}

function saveOrder(roomId: string, sessions: string[]): void {
  try {
    const map = loadOrder();
    delete map[roomId];
    map[roomId] = sessions;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROOMS))) delete map[k];
    localStorage.setItem(ORDER_KEY, JSON.stringify(map));
  } catch {
    // no storage: the order lasts only until reload
  }
}
