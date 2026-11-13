// Order of the rooms in the side list chosen by the user (by dragging the room header), stored in the browser
// by the room id (the project folder). Rooms that aren't in the stored order go to the end, in the order they came.
const ORDER_KEY = 'habblaud.rooms.order';
/** Remembered rooms (the most recent in the list). */
const MAX_ROOMS = 100;

export function orderRooms<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const saved = loadOrder();
  if (!saved.length) return items.slice();
  const rank = new Map(saved.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) }))
    .sort((x, y) => (x.r ?? Infinity) - (y.r ?? Infinity) || x.i - y.i)
    .map((x) => x.item);
}

/** Puts room `from` before (or after) `to` in the `shown` list (ids in the order shown) and stores it. */
export function moveRoom(shown: readonly string[], from: string, to: string, after: boolean): boolean {
  if (from === to || !shown.includes(from) || !shown.includes(to)) return false;
  const rest = shown.filter((id) => id !== from);
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, from);
  // stored rooms that aren't in the list now (closed or filtered) keep their relative position at the end
  const old = loadOrder().filter((id) => !rest.includes(id));
  saveOrder([...rest, ...old].slice(0, MAX_ROOMS));
  return true;
}

function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    // no storage: the order lasts only until reload
  }
}
