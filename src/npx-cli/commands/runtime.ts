/**
 * Runtime command routing for `npx claude-mem start|stop|restart|status|search|transcript`.
 *
 * These commands delegate to the installed plugin's worker-service.cjs via Bun,
 * or hit the worker's HTTP API directly (for `search`).
 *
 * Pure Node.js — no Bun APIs used.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import pc from 'picocolors';
import { resolveBunBinaryPath } from '../utils/bun-resolver.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// Installation guard
// ---------------------------------------------------------------------------

function ensureInstalledOrExit(): void {
  if (!isPluginInstalled()) {
    writeStderr(pc.red('claude-mem is not installed.'));
    writeStderr(`Run: ${pc.bold('npx claude-mem install')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Bun guard
// ---------------------------------------------------------------------------

function resolveBunOrExit(): string {
  const bunPath = resolveBunBinaryPath();
  if (!bunPath) {
    writeStderr(pc.red('Bun not found.'));
    writeStderr('Install Bun: https://bun.sh');
    writeStderr('After installation, restart your terminal.');
    process.exit(1);
  }
  return bunPath;
}

// ---------------------------------------------------------------------------
// Worker-service path
// ---------------------------------------------------------------------------

function workerServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

function spawnBunWorkerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    writeStderr(pc.red(`Worker script not found at: ${workerScript}`));
    writeStderr('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  const args = [workerScript, command, ...extraArgs];

  const child = spawn(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    env: process.env,
  });

  child.on('error', (error) => {
    writeStderr(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runStartCommand(): void {
  spawnBunWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnBunWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnBunWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnBunWorkerCommand('status');
}

/**
 * Search the worker API at `GET /api/search?query=<query>`.
 */
export async function runSearchCommand(queryParts: string[]): Promise<void> {
  ensureInstalledOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    writeStderr(pc.red('Usage: npx claude-mem search <query>'));
    process.exit(1);
  }

  const workerPort = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
  const searchUrl = `http://127.0.0.1:${workerPort}/api/search?query=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(searchUrl);

    if (!response.ok) {
      if (response.status === 404) {
        writeStderr(pc.red('Search endpoint not found. Is the worker running?'));
        writeStderr(`Try: ${pc.bold('npx claude-mem start')}`);
        process.exit(1);
      }
      writeStderr(pc.red(`Search failed: HTTP ${response.status}`));
      process.exit(1);
    }

    const data = await response.json();

    if (typeof data === 'object' && data !== null) {
      writeStdout(JSON.stringify(data, null, 2));
    } else {
      writeStdout(String(data));
    }
  } catch (error: any) {
    if (error?.cause?.code === 'ECONNREFUSED' || error?.message?.includes('ECONNREFUSED')) {
      writeStderr(pc.red('Worker is not running.'));
      writeStderr(`Start it with: ${pc.bold('npx claude-mem start')}`);
      process.exit(1);
    }
    writeStderr(pc.red(`Search failed: ${error.message}`));
    process.exit(1);
  }
}

/**
 * Start the transcript watcher via Bun.
 */
export function runTranscriptWatchCommand(): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();

  const transcriptWatcherPath = join(
    marketplaceDirectory(),
    'plugin',
    'scripts',
    'transcript-watcher.cjs',
  );

  if (!existsSync(transcriptWatcherPath)) {
    // Fall back to worker-service with transcript subcommand
    spawnBunWorkerCommand('transcript', ['watch']);
    return;
  }

  const child = spawn(bunPath, [transcriptWatcherPath, 'watch'], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    env: process.env,
  });

  child.on('error', (error) => {
    writeStderr(pc.red(`Failed to start transcript watcher: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}
