import { describe, expect, it } from 'vitest';
import { WORLD_KNOWN_ERROR_CODES, WORLD_LOCAL_ERROR_CODES, isWorldKnownErrorCode, worldLastError } from './api';
import { WORLD_ERROR_CODES } from './protocol';

describe('World error codes', () => {
  it('those of the world server include the ones the private server sends beyond the contract', () => {
    for (const code of ['no_player', 'unavailable', 'invalid_json', 'too_large', 'unsupported_media_type', 'method_not_allowed', 'name_cooldown', 'device_limit', 'internal']) {
      expect(WORLD_ERROR_CODES as readonly string[], code).toContain(code);
    }
  });

  it('the known list joins the two, without repeating', () => {
    expect(new Set(WORLD_KNOWN_ERROR_CODES).size).toBe(WORLD_KNOWN_ERROR_CODES.length);
    for (const c of [...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES]) expect(isWorldKnownErrorCode(c), c).toBe(true);
    expect(isWorldKnownErrorCode('something_new')).toBe(false);
    expect(isWorldKnownErrorCode(undefined)).toBe(false);
  });

  it('lastError: network becomes network; malformed response, error without a code and new code become unknown', () => {
    expect(worldLastError('world_unreachable')).toBe('network');
    expect(worldLastError('world_timeout')).toBe('network');
    expect(worldLastError('world_bad_response')).toBe('unknown');
    expect(worldLastError('world_error')).toBe('unknown');
    expect(worldLastError('something_new')).toBe('unknown');
    for (const c of ['session_expired', 'storage_failed', 'terminal_off', 'rate_limited', 'unavailable', 'banned', 'internal']) expect(worldLastError(c)).toBe(c);
  });
});
