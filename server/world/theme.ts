// Theme of the building in World: the choice from Settings › Appearance (world.json) resolved to what goes in the
// packet. Automatic follows the office calendar (seasonalThemeFor, client/src/world/api.ts; a test checks that they do
// not drift apart): Halloween from October 1 to 31, Christmas from November 1 to December 26 and, the rest of the
// year, none. The date is the server's local one (in Docker, UTC).
import type { WorldThemeChoice } from '../../shared/world/api';
import type { WorldTheme } from '../../shared/world/protocol';

export function resolveWorldTheme(choice: WorldThemeChoice | undefined, date: Date): WorldTheme {
  if (choice && choice !== 'auto') return choice;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10 || (month === 11 && date.getDate() <= 26)) return 'christmas';
  return 'none';
}
