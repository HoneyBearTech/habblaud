import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeStateMigration, legacyEnvVars, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { tempDir } from './test/fixtures';

describe('variables with the old name', () => {
  it('lists only the CODETOWN_* ones, with the new name, in order', () => {
    expect(legacyEnvVars(['PATH', 'CODETOWN_PORT', 'HABBLAUD_BIND', 'CODETOWN_BIND'])).toEqual([
      { from: 'CODETOWN_BIND', to: 'HABBLAUD_BIND' },
      { from: 'CODETOWN_PORT', to: 'HABBLAUD_PORT' },
    ]);
  });

  it('warns only when there is one', () => {
    expect(legacyEnvWarning(['PATH', 'HABBLAUD_PORT'])).toBeUndefined();
    expect(legacyEnvWarning(['CODETOWN_PORT'], 'in .env')).toBe(
      'old-name variable ignored in .env: CODETOWN_PORT → HABBLAUD_PORT. Rename to re-enable.',
    );
  });
});

describe('migrateLegacyStateDir', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  const write = (rel: string, text: string) => {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), text);
  };
  const read = (rel: string) => readFileSync(join(home, rel), 'utf8');

  beforeEach(() => {
    tmp = tempDir('habblaud-legacy-');
    home = tmp.dir;
  });
  afterEach(() => tmp.cleanup());

  it('without the old folder, does nothing', () => {
    expect(migrateLegacyStateDir(home)).toEqual({ moved: [] });
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
  });

  it('without the new folder, renames the whole old one', () => {
    write('.codetown/names.json', '{"a":"Marina"}');
    write('.codetown/usage/.claude.json', '{}');
    const r = migrateLegacyStateDir(home);
    expect(r).toEqual({ moved: ['.'] });
    expect(read('.habblaud/names.json')).toBe('{"a":"Marina"}');
    expect(existsSync(join(home, '.habblaud/usage/.claude.json'))).toBe(true);
    expect(existsSync(join(home, '.codetown'))).toBe(false);
    expect(describeStateMigration(r)).toBe('~/.codetown (old name) is now ~/.habblaud.');
  });

  it('with the new folder already created, moves what is missing and, for files on both sides, the most recent stays', () => {
    const at = (rel: string, minutes: number) => {
      const t = new Date(2026, 9, 8, 18, minutes);
      utimesSync(join(home, rel), t, t);
    };
    write('.codetown/names.json', 'old');
    write('.codetown/usage/.claude.json', 'old');
    write('.codetown/usage/.claude-conta2.json', 'old, but more recent');
    write('.habblaud/usage/.claude.json', 'new');
    write('.habblaud/usage/.claude-conta2.json', 'new, but stale');
    at('.codetown/usage/.claude.json', 10);
    at('.habblaud/usage/.claude.json', 20);
    at('.codetown/usage/.claude-conta2.json', 30);
    at('.habblaud/usage/.claude-conta2.json', 20);
    const r = migrateLegacyStateDir(home);
    expect(r.moved.sort()).toEqual(['names.json', 'usage/.claude-conta2.json']);
    expect(read('.habblaud/names.json')).toBe('old');
    expect(read('.habblaud/usage/.claude.json')).toBe('new');
    expect(read('.habblaud/usage/.claude-conta2.json')).toBe('old, but more recent');
    // What lost to a newer file stays in the old folder, which then doesn't go away.
    expect(read('.codetown/usage/.claude.json')).toBe('old');
    expect(describeStateMigration(r)).toContain('names.json, usage/.claude-conta2.json');
  });

  it('old folder with nothing that is missing: goes away', () => {
    mkdirSync(join(home, '.codetown'));
    mkdirSync(join(home, '.habblaud'));
    expect(migrateLegacyStateDir(home)).toEqual({ moved: [] });
    expect(existsSync(join(home, '.codetown'))).toBe(false);
  });

  it('does not throw: returns the error (e.g.: ~/.habblaud is a file)', () => {
    write('.codetown/names.json', '{}');
    write('.habblaud', 'file');
    const r = migrateLegacyStateDir(home);
    expect(r).toEqual({ moved: [], error: `${join(home, '.habblaud')} exists and isn't a folder` });
    expect(existsSync(join(home, '.codetown/names.json'))).toBe(true);
    expect(describeStateMigration(r)).toMatch(/^couldn't move ~\/\.codetown to ~\/\.habblaud/);
  });
});
