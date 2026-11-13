// Room names chosen by the user (right-click > Rename), persisted per folder in <dataDir>/rooms.json.
// With no alias, the room uses the folder's name (model/rooms.ts roomDisplayNames); `defaults` gives fixed names to
// known folders (the assets folder shows up as "Architect").
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

export const ROOM_NAME_MAX = 40;

/** Comparable key of a path (forward slashes, no trailing slash, no difference in letter case). */
export function pathKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class RoomAliases {
  private aliases = new Map<string, string>();
  private readonly defaults = new Map<string, string>();

  /** `file` null = in memory only (tests). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { aliases?: Record<string, unknown> };
      for (const [k, v] of Object.entries(j.aliases ?? {})) if (typeof v === 'string' && v.trim()) this.aliases.set(pathKey(k), v.trim().slice(0, ROOM_NAME_MAX));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('rooms.json unreadable ({0}); no custom room names.', [errMsg(err)]));
    }
  }

  /** Fixed name for a folder when the user has not chosen another one. */
  setDefault(path: string, name: string): void {
    this.defaults.set(pathKey(path), name);
  }

  get(path: string): string | undefined {
    const k = pathKey(path);
    return this.aliases.get(k) ?? this.defaults.get(k);
  }

  /** Sets the name of the folder's room; empty goes back to the default. Returns the name in use. */
  set(path: string, name: string): string | undefined {
    const k = pathKey(path);
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
    if (clean) this.aliases.set(k, clean);
    else this.aliases.delete(k);
    this.save();
    return this.get(path);
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, aliases: Object.fromEntries(this.aliases) }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(tr("Couldn't write {0}: {1}", [this.file, errMsg(err)]));
    }
  }
}
