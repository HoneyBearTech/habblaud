// Pure functions of scripts/docker-up.ts (importing the module doesn't start anything).
import { describe, expect, it } from 'vitest';
import type { DetectedAccount } from '../accounts/detect';
import { legacyEnvWarning } from '../legacy';
import {
  accountsPayload,
  CODEX_MOUNTED_SUBDIRS,
  codexAccountsPayload,
  codexDisabled,
  copyVolumeArgs,
  type DockerState,
  envFileKeys,
  hostTimeZone,
  parseArgs,
  planCodexMounts,
  planMounts,
  planUp,
  renderOverride,
  sanitizeCachedUsage,
  worldLine,
  yamlString,
} from '../../scripts/docker-up';

const acc = (id: string, extra: Partial<DetectedAccount> = {}): DetectedAccount => ({
  id,
  configDir: `/Users/fulano/${id}`,
  short: id === '.claude' ? 'C' : 'D',
  name: id === '.claude' ? 'Account C' : 'Account D',
  color: '#000000',
  ...extra,
});

/** The host paths here are written with `/`; on Windows, planMounts' join returns them with `\`. */
const slash = (p: string) => p.replaceAll('\\', '/');

describe('docker-up', () => {
  it('the Habblaud World line: the default without URL; on with the checked address; the environment counts more than the .env', () => {
    expect(worldLine({})).toBe('Habblaud World: on: https://server.habblaud.com (default)');
    expect(worldLine({ HABBLAUD_WORLD_URL: 'wss://server.habblaud.com/' })).toBe('Habblaud World: on: https://server.habblaud.com');
    // From .env (Compose reads it on its own), with quotes.
    const file = 'HABBLAUD_WORLD_URL="http://host.docker.internal:4848"\nHABBLAUD_WORLD_DEV=1\n';
    expect(worldLine({}, file)).toBe('Habblaud World: on: http://host.docker.internal:4848');
    // Without development mode, http:// is refused (and the reason shows); in the container there is no --dev.
    expect(worldLine({ HABBLAUD_WORLD_URL: 'http://host.docker.internal:4848' })).toMatch(/^Habblaud World: off \(HABBLAUD_WORLD_URL with http:\/\/.*development/);
    // The environment wins over .env, even when empty.
    expect(worldLine({ HABBLAUD_WORLD_URL: '' }, file)).toBe('Habblaud World: on: https://server.habblaud.com (default)');
    expect(worldLine({ HABBLAUD_WORLD: '0' }, file)).toBe('Habblaud World: off (HABBLAUD_WORLD=0).');
    // Never repeats the raw URL (it may have a user and password).
    expect(worldLine({ HABBLAUD_WORLD_URL: 'https://ana:secret@server.habblaud.com' })).not.toContain('secret');
  });

  it('arguments', () => {
    expect(parseArgs([])).toEqual({ down: false, build: true, help: false });
    expect(parseArgs(['--no-build'])).toEqual({ down: false, build: false, help: false });
    expect(parseArgs(['--down'])).toMatchObject({ down: true });
    expect(() => parseArgs(['--xyz'])).toThrow(/unknown option/);
  });

  it('mounts only the projects/ and sessions/ that exist', () => {
    const dirs = ['/Users/fulano/.claude', '/Users/fulano/.claude-conta2'];
    const exists = new Set(['/Users/fulano/.claude/projects', '/Users/fulano/.claude/sessions', '/Users/fulano/.claude-conta2/sessions']);
    const mounts = planMounts(dirs, [acc('.claude'), acc('.claude-conta2')], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(mounts.map((m) => m.binds)).toEqual([
      [
        { source: '/real/Users/fulano/.claude/projects', target: '/claude/.claude/projects' },
        { source: '/real/Users/fulano/.claude/sessions', target: '/claude/.claude/sessions' },
      ],
      [{ source: '/real/Users/fulano/.claude-conta2/sessions', target: '/claude/.claude-conta2/sessions' }],
    ]);
  });

  it('usage cache: only date and percentages/resets of the displayed windows', () => {
    expect(sanitizeCachedUsage(null)).toBeUndefined();
    expect(
      sanitizeCachedUsage({
        fetchedAtMs: 5,
        accountUuid: 'no',
        utilization: { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: 'x' }, extra_usage: { monthly_limit: 99 } },
      }),
    ).toEqual({ fetchedAtMs: 5, utilization: { five_hour: { utilization: 10 }, seven_day: { utilization: 20, resets_at: 'x' } } });
  });

  it('override: read-only, without creating folders on the host, `$` escaped and the statusline folder at /usage', () => {
    const mounts = planMounts(['/Users/fu$lano/.claude'], [acc('.claude', { email: 'a@b.c', cachedUsage: { fetchedAtMs: 1, utilization: {} } })], slash);
    const yml = renderOverride(mounts, new Date('2026-10-06T00:00:00Z'), '/Users/fulano/.habblaud/usage');
    expect(yml).toContain('source: "/Users/fu$$lano/.claude/projects"');
    expect(yml).toContain('HABBLAUD_USAGE_DIR: "/usage"');
    expect(yml).toContain('source: "/Users/fulano/.habblaud/usage"\n        target: "/usage"\n        read_only: true');
    const binds = yml.split('- type: bind').length - 1;
    expect(binds).toBe(3);
    expect(yml.match(/read_only: true/g)).toHaveLength(3);
    expect(yml.match(/create_host_path: false/g)).toHaveLength(3);
    // Accounts payload: no empty cache, no fields that don't exist.
    expect(accountsPayload(mounts)).toEqual([{ id: '.claude', configDir: '/Users/fulano/.claude', mountDir: '/claude/.claude', short: 'C', name: 'Account C', color: '#000000', email: 'a@b.c' }]);
    // Without the statusline folder: no /usage.
    expect(renderOverride(mounts)).not.toContain('/usage');
    expect(yamlString('a"b$c')).toBe('"a\\"b$$c"');
  });

  it('Codex: mounts ONLY sessions/, archived_sessions/ and thread-writer-locks/ (read-only) and passes the accounts with the host folder', () => {
    expect([...CODEX_MOUNTED_SUBDIRS]).toEqual(['sessions', 'archived_sessions', 'thread-writer-locks']);
    const host = '/Users/fulano/.codex';
    // The host also has auth.json, config.toml, history.jsonl, shell_snapshots/, logs and SQLite: none of that goes in.
    const exists = new Set([`${host}/sessions`, `${host}/thread-writer-locks`, `${host}/auth.json`, `${host}/config.toml`, `${host}/shell_snapshots`, `${host}/history.jsonl`]);
    const codexAcc: DetectedAccount = { id: '.codex', provider: 'codex', configDir: host, short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' };
    const codex = planCodexMounts([host, '/Users/fulano/.codex-empty'], [codexAcc, { ...codexAcc, id: '.codex-empty' }], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(codex.map((m) => m.binds)).toEqual([
      [
        { source: `/real${host}/sessions`, target: '/codex/.codex/sessions' },
        { source: `/real${host}/thread-writer-locks`, target: '/codex/.codex/thread-writer-locks' },
      ],
    ]);
    expect(codexAccountsPayload(codex)).toEqual([
      { id: '.codex', provider: 'codex', configDir: host, mountDir: '/codex/.codex', short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' },
    ]);
    const claude = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    const yml = renderOverride(claude, new Date(0), undefined, undefined, codex);
    expect(yml).toContain('HABBLAUD_CODEX_DIRS: "/codex/.codex"');
    expect(yml).toContain(`source: "/real${host}/thread-writer-locks"\n        target: "/codex/.codex/thread-writer-locks"\n        read_only: true`);
    expect(yml.match(/read_only: true/g)).toHaveLength(4);
    for (const secret of ['auth.json', 'config.toml', 'history.jsonl', 'shell_snapshots', 'sqlite', 'logs_']) expect(yml).not.toContain(secret);
    const accounts = JSON.parse(JSON.parse(/HABBLAUD_ACCOUNTS: (".*")/.exec(yml)![1]) as string) as Array<Record<string, unknown>>;
    expect(accounts.map((a) => [a.id, a.provider, a.configDir])).toEqual([
      ['.claude', undefined, '/Users/fulano/.claude'],
      ['.codex', 'codex', host],
    ]);
    // Without Codex: no HABBLAUD_CODEX_DIRS.
    expect(renderOverride(claude)).not.toContain('HABBLAUD_CODEX_DIRS');
    expect(codexDisabled({ HABBLAUD_CODEX: '0' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: 'off' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: '1' })).toBe(false);
    expect(codexDisabled({})).toBe(false);
  });

  it('host time zone goes to the container as TZ', () => {
    const mounts = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    expect(renderOverride(mounts, new Date(0), undefined, 'America/Sao_Paulo')).toContain('TZ: "America/Sao_Paulo"');
    expect(renderOverride(mounts)).not.toContain('TZ:');
    expect(hostTimeZone({ TZ: 'America/Sao_Paulo' })).toBe('America/Sao_Paulo');
    expect(hostTimeZone({ TZ: ':Europe/Lisbon' })).toBe('Europe/Lisbon');
    expect(hostTimeZone({ TZ: 'x"; rm -rf' })).toBeUndefined();
    expect(hostTimeZone({})).toMatch(/^[A-Za-z]/);
  });
});

describe('docker-up: migration from the old name (CodeTown)', () => {
  const none: DockerState = { legacyContainer: false, legacyNetwork: false, legacyVolume: false, legacyImage: false, dataVolume: false };
  const upBuild = { kind: 'compose', args: ['up', '-d', '--build'] };

  it('nothing from CodeTown: only the usual compose up', () => {
    expect(planUp(none, true)).toEqual({ steps: [upBuild], cleanup: [] });
    expect(planUp(none, false)).toEqual({ steps: [{ kind: 'compose', args: ['up', '-d'] }], cleanup: [] });
  });

  it('first start after the rename: removes container and network, Compose creates the volume and the data is copied', () => {
    const plan = planUp({ legacyContainer: true, legacyNetwork: true, legacyVolume: true, legacyImage: true, dataVolume: false }, true);
    expect(plan.steps).toEqual([
      { kind: 'remove-container', name: 'codetown' },
      { kind: 'remove-network', name: 'codetown_default' },
      { kind: 'compose', args: ['up', '--no-start', '--build'] },
      { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
      { kind: 'compose', args: ['up', '-d'] },
    ]);
    // The old volume is never deleted: it only becomes a hint at the end, along with the image.
    expect(plan.cleanup).toEqual(['docker volume rm codetown_codetown-data', 'docker image rm codetown:local']);
  });

  it('--no-build and old container already taken down: creates it stopped without rebuilding, copies and starts', () => {
    expect(planUp({ ...none, legacyVolume: true }, false)).toEqual({
      steps: [
        { kind: 'compose', args: ['up', '--no-start'] },
        { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
        { kind: 'compose', args: ['up', '-d'] },
      ],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('new volume already exists: does not copy over it', () => {
    // Already migrated before: the old volume stayed, but there is nothing to do or to remind.
    expect(planUp({ ...none, legacyVolume: true, legacyImage: true, dataVolume: true }, true)).toEqual({ steps: [upBuild], cleanup: [] });
    // Old container up with both volumes: the container goes, with no copy.
    expect(planUp({ ...none, legacyContainer: true, legacyVolume: true, dataVolume: true }, true)).toEqual({
      steps: [{ kind: 'remove-container', name: 'codetown' }, upBuild],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('only the network or the image is left: removes the network, without a hint', () => {
    expect(planUp({ ...none, legacyNetwork: true, legacyImage: true }, true)).toEqual({
      steps: [{ kind: 'remove-network', name: 'codetown_default' }, upBuild],
      cleanup: [],
    });
  });

  it('copy: Habblaud image as root, without network, old volume read-only', () => {
    const args = copyVolumeArgs('old', 'new');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('--user 0:0 --entrypoint sh');
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('-v old:/from:ro -v new:/to habblaud:local -c ');
    const script = args.at(-1)!;
    expect(script).toMatch(/^set -e; cp -a \/from\/\. \/to\/;/);
    expect(script).toContain('chown "$(stat -c %u:%g /from)" /to');
  });

  it('.env: only the names of the variables, never the values', () => {
    const text = [
      '# CODETOWN_COMMENTED=1',
      'CODETOWN_BIND=0.0.0.0',
      '  export CODETOWN_PORT = 4848',
      'HABBLAUD_DEMO=1',
      '',
      'NO_EQUALS',
      '1INVALID=x',
      'SECRET=CODETOWN_X=y\r',
    ].join('\n');
    const keys = envFileKeys(text);
    expect(keys).toEqual(['CODETOWN_BIND', 'CODETOWN_PORT', 'HABBLAUD_DEMO', 'SECRET']);
    const msg = legacyEnvWarning(keys, 'in .env');
    expect(msg).toBe('old-name variables ignored in .env: CODETOWN_BIND → HABBLAUD_BIND, CODETOWN_PORT → HABBLAUD_PORT. Rename to re-enable.');
    expect(msg).not.toContain('0.0.0.0');
    expect(envFileKeys('')).toEqual([]);
  });
});
