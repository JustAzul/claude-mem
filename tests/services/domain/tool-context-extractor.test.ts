import { describe, it, expect } from 'bun:test';
import {
  extractToolMetadata,
  extractBashFilesRead,
  extractBashFilesModified,
} from '../../../src/services/domain/ToolContextExtractor.js';

// ─── extractBashFilesRead ────────────────────────────────────────────────────

describe('extractBashFilesRead — cat', () => {
  it('single file', () => {
    expect(extractBashFilesRead('cat src/foo.ts')).toEqual(['src/foo.ts']);
  });

  it('multiple files', () => {
    expect(extractBashFilesRead('cat src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('-n flag before file', () => {
    expect(extractBashFilesRead('cat -n src/foo.ts')).toEqual(['src/foo.ts']);
  });
});

describe('extractBashFilesRead — head / tail', () => {
  it('head -n N file', () => {
    expect(extractBashFilesRead('head -n 20 src/foo.ts')).toEqual(['src/foo.ts']);
  });

  it('tail -f file', () => {
    expect(extractBashFilesRead('tail -f src/bar.ts')).toEqual(['src/bar.ts']);
  });
});

describe('extractBashFilesRead — grep / rg', () => {
  it('grep: pattern + file', () => {
    expect(extractBashFilesRead('grep pattern src/foo.ts')).toEqual(['src/foo.ts']);
  });

  it('grep: -r flag + pattern + dir', () => {
    expect(extractBashFilesRead('grep -r pattern src/')).toEqual(['src/']);
  });

  it('rg: pattern + dir', () => {
    expect(extractBashFilesRead('rg TODO src/services/')).toEqual(['src/services/']);
  });

  it('rg: pattern only → empty', () => {
    expect(extractBashFilesRead('rg TODO')).toEqual([]);
  });
});

describe('extractBashFilesRead — git (always empty)', () => {
  it('git log', () => expect(extractBashFilesRead('git log --oneline')).toEqual([]));
  it('git diff', () => expect(extractBashFilesRead('git diff HEAD~1')).toEqual([]));
  it('git status', () => expect(extractBashFilesRead('git status')).toEqual([]));
});

describe('extractBashFilesRead — pipe', () => {
  it('only parses first segment', () => {
    expect(extractBashFilesRead('cat src/foo.ts | grep bar')).toEqual(['src/foo.ts']);
  });
});

describe('extractBashFilesRead — edge cases', () => {
  it('bare ls → empty', () => expect(extractBashFilesRead('ls')).toEqual([]));
  it('ls with path', () => expect(extractBashFilesRead('ls src/services/')).toEqual(['src/services/']));
});

// ─── extractBashFilesModified ────────────────────────────────────────────────

describe('extractBashFilesModified — output redirection', () => {
  it('> creates file', () => {
    expect(extractBashFilesModified('echo hello > src/out.ts')).toEqual(['src/out.ts']);
  });

  it('>> appends to file', () => {
    expect(extractBashFilesModified('echo hello >> src/out.ts')).toEqual(['src/out.ts']);
  });
});

describe('extractBashFilesModified — sed -i', () => {
  it('sed -i in-place edit', () => {
    expect(extractBashFilesModified("sed -i 's/foo/bar/' src/foo.ts")).toEqual(['src/foo.ts']);
  });

  it('sed without -i → empty', () => {
    expect(extractBashFilesModified("sed 's/foo/bar/' src/foo.ts")).toEqual([]);
  });

  it('sed -i multiple files', () => {
    expect(extractBashFilesModified("sed -i 's/foo/bar/' src/a.ts src/b.ts")).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('extractBashFilesModified — mv / cp', () => {
  it('mv: last arg is destination', () => {
    expect(extractBashFilesModified('mv src/a.ts src/b.ts')).toEqual(['src/b.ts']);
  });

  it('cp: last arg is destination', () => {
    expect(extractBashFilesModified('cp src/a.ts dist/a.ts')).toEqual(['dist/a.ts']);
  });
});

describe('extractBashFilesModified — tee / rm / touch', () => {
  it('tee: arg is written file', () => {
    expect(extractBashFilesModified('tee src/out.ts')).toEqual(['src/out.ts']);
  });

  it('rm: all args removed', () => {
    expect(extractBashFilesModified('rm src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('touch: file created/updated', () => {
    expect(extractBashFilesModified('touch src/new.ts')).toEqual(['src/new.ts']);
  });
});

describe('extractBashFilesModified — unknown/safe commands → empty', () => {
  it('npm run build', () => expect(extractBashFilesModified('npm run build')).toEqual([]));
  it('bun test', () => expect(extractBashFilesModified('bun test')).toEqual([]));
});

// ─── extractToolMetadata Bash — integration smoke tests ─────────────────────

describe('extractToolMetadata Bash', () => {
  it('cat → discovery + files_read', () => {
    const result = extractToolMetadata('Bash', { command: 'cat src/foo.ts' });
    expect(result.type_override).toBe('discovery');
    expect(result.files_read).toEqual(['src/foo.ts']);
    expect(result.files_modified).toEqual([]);
  });

  it('grep → discovery + files_read', () => {
    const result = extractToolMetadata('Bash', { command: 'grep -r pattern src/' });
    expect(result.type_override).toBe('discovery');
    expect(result.files_read).toEqual(['src/']);
  });

  it('git status → discovery, no files', () => {
    const result = extractToolMetadata('Bash', { command: 'git status' });
    expect(result.type_override).toBe('discovery');
    expect(result.files_read).toEqual([]);
    expect(result.files_modified).toEqual([]);
  });

  it('sed -i → no override + files_modified', () => {
    const result = extractToolMetadata('Bash', { command: "sed -i 's/foo/bar/' src/foo.ts" });
    expect(result.type_override).toBeUndefined();
    expect(result.files_read).toEqual([]);
    expect(result.files_modified).toEqual(['src/foo.ts']);
  });

  it('echo redirect → no override + files_modified', () => {
    const result = extractToolMetadata('Bash', { command: 'echo hello > src/out.ts' });
    expect(result.type_override).toBeUndefined();
    expect(result.files_read).toEqual([]);
    expect(result.files_modified).toEqual(['src/out.ts']);
  });

  it('npm run build → no override, no files', () => {
    const result = extractToolMetadata('Bash', { command: 'npm run build' });
    expect(result.type_override).toBeUndefined();
    expect(result.files_read).toEqual([]);
    expect(result.files_modified).toEqual([]);
  });
});
