import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { parseWorldSession, WorldSettingsStore } from './settings';

setQuiet(true);

const TOKEN = 'T0k3n_secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SESSION = { deviceId: 'dev_1', token: TOKEN, email: 'ana@example.com', access: 'waiting' as const };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setQuiet(true);
});

function store(now = () => 1_000) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const file = join(tmp.dir, 'data', 'world.json');
  return { file, dir: join(tmp.dir, 'data'), store: new WorldSettingsStore(file, now) };
}

describe('WorldSettingsStore', () => {
  it('writes with mode 600 (no temporary file left over) and rereads the same', () => {
    const { file, dir, store: s } = store();
    expect(s.load()).toBeUndefined();
    expect(s.save(SESSION)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['world.json']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...SESSION, updatedAt: 1_000 });
    expect(new WorldSettingsStore(file).load()).toEqual({ ...SESSION, updatedAt: 1_000 });
  });

  it('tightens the permission of a file that is too open when reading', () => {
    const { file, store: s } = store();
    s.save(SESSION);
    chmodSync(file, 0o644);
    expect(new WorldSettingsStore(file).load()?.token).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('the 600 also holds over an old temporary file with another permission', () => {
    const { file, dir, store: s } = store();
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.${process.pid}.tmp`, 'old', { mode: 0o644 });
    s.save(SESSION);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('update changes only access and character; clear deletes the file', () => {
    let now = 1_000;
    const { file, store: s } = store(() => now);
    expect(s.update({ access: 'approved' })).toBe(false); // without a session, nothing
    s.save(SESSION);
    now = 2_000;
    s.update({ access: 'approved' });
    expect(s.get()).toEqual({ ...SESSION, access: 'approved', updatedAt: 2_000 });
    s.clear();
    expect(s.get()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it('theme: stays in world.json with or without session and survives signing out; a file with only the theme is not a broken file', () => {
    const { file, store: s } = store();
    expect(s.getTheme()).toBe('auto');
    s.setTheme('halloween');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'halloween' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    s.save(SESSION);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...SESSION, updatedAt: 1_000, theme: 'halloween' });
    s.clear();
    expect(s.get()).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'halloween' });
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = new WorldSettingsStore(file);
    expect(again.load()).toBeUndefined();
    expect(again.getTheme()).toBe('halloween');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    // Back to automatic and without a session: the file goes away.
    again.setTheme('auto');
    expect(existsSync(file)).toBe(false);
  });

  it('deleted account (erase): the whole world.json disappears, theme included; again, nothing breaks', () => {
    const { file, store: s } = store();
    s.save(SESSION);
    s.setTheme('christmas');
    expect(s.erase()).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(s.get()).toBeUndefined();
    expect(s.getTheme()).toBe('auto');
    expect(s.erase()).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('pause: stays in the session and goes away with undefined', () => {
    const { file, store: s } = store();
    s.save(SESSION);
    s.update({ paused: true });
    expect(new WorldSettingsStore(file).load()?.paused).toBe(true);
    s.update({ paused: undefined });
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('paused');
    expect(new WorldSettingsStore(file).load()?.paused).toBeUndefined();
  });

  it('broken or out-of-format file: ignored, and the log never shows the content', () => {
    const { file, dir, store: s } = store();
    mkdirSync(dir, { recursive: true });
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(file, `{"token": "${TOKEN}", junk`, { mode: 0o600 });
    expect(s.load()).toBeUndefined();
    writeFileSync(file, JSON.stringify({ ...SESSION, access: 'banido' }), { mode: 0o600 });
    expect(s.load()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it('disk that refuses: the session holds in memory and the warning does not carry the token', () => {
    const { dir, store: _ } = store();
    mkdirSync(dir, { recursive: true });
    // A file in place of the folder: the mkdir/rename fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const s = new WorldSettingsStore(join(blocker, 'world.json'));
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(s.save(SESSION)).toBe(false);
    expect(s.get()?.token).toBe(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    warn.mockRestore();
  });
});

describe('parseWorldSession', () => {
  it('checks each field', () => {
    expect(parseWorldSession({ ...SESSION, updatedAt: 5 })).toEqual({ ...SESSION, updatedAt: 5 });
    expect(parseWorldSession({ ...SESSION, token: 'short' })).toBeUndefined();
    expect(parseWorldSession({ ...SESSION, deviceId: '../x' })).toBeUndefined();
    expect(parseWorldSession({ ...SESSION, email: 'no-at-sign' })).toBeUndefined();
    expect(parseWorldSession({ ...SESSION, access: 'banned' })).toBeUndefined();
    expect(parseWorldSession([SESSION])).toBeUndefined();
    expect(parseWorldSession({ ...SESSION, player: 'x' })).toEqual({ ...SESSION, updatedAt: 0 });
  });
});
