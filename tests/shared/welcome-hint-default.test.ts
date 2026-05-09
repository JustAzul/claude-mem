
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  existsSync as _existsSyncForMock,
  mkdirSync as _mkdirSyncForMock,
  readFileSync as _readFileSyncForMock,
  writeFileSync as _writeFileSyncForMock,
} from 'fs';
import { dirname as _dirnameForMock } from 'path';

// Defensive override: chroma-mcp-manager-ssl, file-context, summarize-subagent-skip,
// and summarize-tag-stripping all `mock.module` SettingsDefaultsManager with stubs
// missing `getAllDefaults` + a real `loadFromFile`. Bun has no per-file mock-module
// restore, so this top-level call wins for THIS file's import resolution. Reuses the
// real semantics: defaults applied, file auto-created when missing, explicit values win.
mock.module('../../src/shared/SettingsDefaultsManager.js', () => {
  const DEFAULTS = { CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true' } as Record<string, string>;
  return {
    SettingsDefaultsManager: {
      getAllDefaults: () => ({ ...DEFAULTS }),
      loadFromFile: (settingsPath: string) => {
        if (!_existsSyncForMock(settingsPath)) {
          const dir = _dirnameForMock(settingsPath);
          if (!_existsSyncForMock(dir)) _mkdirSyncForMock(dir, { recursive: true });
          _writeFileSyncForMock(settingsPath, JSON.stringify(DEFAULTS, null, 2), 'utf-8');
          return { ...DEFAULTS };
        }
        const parsed = JSON.parse(_readFileSyncForMock(settingsPath, 'utf-8'));
        return { ...DEFAULTS, ...parsed };
      },
    },
  };
});

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('CLAUDE_MEM_WELCOME_HINT_ENABLED default', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `welcome-hint-default-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    originalEnvValue = process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
    } else {
      process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED = originalEnvValue;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('is set to "true" in getAllDefaults()', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('true');
  });

  it('resolves to "true" when settings file is missing (auto-created with defaults)', () => {
    expect(existsSync(settingsPath)).toBe(false);

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('true');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('resolves to "true" when settings file is empty JSON object', () => {
    writeFileSync(settingsPath, '{}', 'utf-8');

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('true');
  });

  it('preserves an explicit "false" value through loadFromFile', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false' }, null, 2),
      'utf-8',
    );

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('false');
  });
});
