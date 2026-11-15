import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { copilotOverrides, defaultCopilotHome, detectCopilotAccounts, discoverCopilotDirs } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpHome(): string {
  const t = tempDir('habblaud-copilot-acc-');
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('Copilot accounts: discovery', () => {
  it('~/.copilot only counts with session-state/', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.copilot'));
    expect(discoverCopilotDirs({}, home)).toEqual([]);
    mkdirSync(join(home, '.copilot', 'session-state'));
    expect(discoverCopilotDirs({}, home)).toEqual([join(home, '.copilot')]);
  });

  it('COPILOT_HOME replaces the default folder', () => {
    const home = tmpHome();
    mkdirSync(join(home, 'cop', 'session-state'), { recursive: true });
    mkdirSync(join(home, '.copilot', 'session-state'), { recursive: true });
    expect(defaultCopilotHome({ COPILOT_HOME: '~/cop' }, home)).toBe(join(home, 'cop'));
    expect(discoverCopilotDirs({ COPILOT_HOME: '~/cop' }, home)).toEqual([join(home, 'cop')]);
  });

  it('HABBLAUD_COPILOT_DIRS replaces the discovery (existing folders only, no repeats)', () => {
    const home = tmpHome();
    mkdirSync(join(home, 'a'));
    mkdirSync(join(home, '.copilot', 'session-state'), { recursive: true });
    expect(discoverCopilotDirs({ HABBLAUD_COPILOT_DIRS: `${join(home, 'a')}, ~/a ,${join(home, 'missing')}` }, home)).toEqual([join(home, 'a')]);
  });
});

describe('Copilot accounts: metadata', () => {
  it('one account: "Copilot", id = folder name, a letter and color not taken', () => {
    const home = tmpHome();
    const [a] = detectCopilotAccounts([join(home, '.copilot')], { home, env: {}, taken: { shorts: ['P', 'c'], colors: ['#f08a3c'] } });
    expect(a).toMatchObject({ id: '.copilot', provider: 'copilot', name: 'Copilot', short: 'G', configDir: join(home, '.copilot'), color: '#4aa8e8' });
  });

  it('two accounts: "Copilot <letter>", the suffix initial and the shell alias', () => {
    const home = tmpHome();
    writeFileSync(join(home, '.zshrc'), `alias cp2='COPILOT_HOME=${join(home, '.copilot-x')} copilot'\nalias q='copilot --banner'\n`);
    const list = detectCopilotAccounts([join(home, '.copilot'), join(home, '.copilot-work'), join(home, '.copilot-x')], { home, env: {} });
    expect(list.map((a) => [a.id, a.short, a.name])).toEqual([
      ['.copilot', 'Q', 'Copilot Q'],
      ['.copilot-work', 'W', 'Copilot W'],
      ['.copilot-x', 'CP2', 'Copilot CP2'],
    ]);
  });

  it('HABBLAUD_ACCOUNTS (Docker) brings the host folder and metadata of the Copilot entries only', () => {
    const raw = JSON.stringify([
      { id: '.copilot', provider: 'copilot', mountDir: '/copilot/.copilot', configDir: '/Users/x/.copilot', short: 'P', name: 'Copilot', color: '#5cc97b' },
      { id: '.codex', provider: 'codex', mountDir: '/codex/.codex' },
    ]);
    expect(copilotOverrides(raw)).toHaveLength(1);
    const [a] = detectCopilotAccounts(['/copilot/.copilot'], { home: '/root', env: { HABBLAUD_ACCOUNTS: raw } });
    expect(a).toMatchObject({ id: '.copilot', configDir: '/Users/x/.copilot', short: 'P', color: '#5cc97b' });
  });
});
