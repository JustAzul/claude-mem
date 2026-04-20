import { logger } from '../../utils/logger.js';

export interface ToolMetadata {
  files_read: string[];
  files_modified: string[];
  /** Defined only when the tool mandates a type override; undefined means preserve LLM value. */
  type_override?: string;
}

/**
 * Derive deterministic file-path metadata and optional type override from a tool call.
 *
 * This runs post-parse to replace LLM-inferred metadata with ground-truth values.
 * The LLM has ~60% type accuracy and ~100% miss rate on files_read for read-only
 * tools, so structural fields are derived from the tool trace, not the LLM response.
 *
 * Tool inputs are treated as untrusted JSON objects — all field access uses typeof
 * guards rather than casts.
 */
export function extractToolMetadata(toolName: string, rawToolInput: unknown): ToolMetadata {
  const input = normalizeToolInput(rawToolInput);

  switch (toolName) {
    case '__init__':
      return {
        files_read: [],
        files_modified: [],
        type_override: 'discovery',
      };

    case 'Read': {
      const filePath = getStringField(input, 'file_path');
      return {
        files_read: filePath ? [filePath] : [],
        files_modified: [],
        type_override: 'discovery',
      };
    }

    case 'Grep': {
      const path = getStringField(input, 'path');
      return {
        files_read: path ? [path] : [],
        files_modified: [],
        type_override: 'discovery',
      };
    }

    case 'Glob': {
      return {
        files_read: [],
        files_modified: [],
        type_override: 'discovery',
      };
    }

    case 'Edit': {
      const filePath = getStringField(input, 'file_path');
      return {
        files_read: [],
        files_modified: filePath ? [filePath] : [],
      };
    }

    case 'Write': {
      const filePath = getStringField(input, 'file_path');
      return {
        files_read: [],
        files_modified: filePath ? [filePath] : [],
      };
    }

    case 'MultiEdit': {
      const filePath = getStringField(input, 'file_path');
      return {
        files_read: [],
        files_modified: filePath ? [filePath] : [],
      };
    }

    case 'NotebookEdit': {
      const notebookPath = getStringField(input, 'notebook_path');
      return {
        files_read: [],
        files_modified: notebookPath ? [notebookPath] : [],
      };
    }

    case 'Bash': {
      const command = getStringField(input, 'command') ?? '';
      const readOnly = isBashReadOnly(command);
      return {
        files_read: readOnly ? extractBashFilesRead(command) : [],
        files_modified: readOnly ? [] : extractBashFilesModified(command),
        ...(readOnly ? { type_override: 'discovery' } : {}),
      };
    }

    case 'Task':
    case 'TodoWrite':
    case 'WebFetch':
      return {
        files_read: [],
        files_modified: [],
      };

    default:
      logger.warn('TOOL_CONTEXT', 'Unknown tool name; file metadata left empty', { toolName });
      return {
        files_read: [],
        files_modified: [],
      };
  }
}

const READ_ONLY_BASH_PREFIXES = [
  'grep ', 'grep\t', 'rg ', 'rg\t',
  'git log', 'git status', 'git diff', 'git show', 'git blame', 'git branch',
  'git remote', 'git tag', 'git stash list', 'git rev-parse', 'git describe',
  'cat ', 'cat\t', 'ls ', 'ls\t', 'ls\n', 'find ', 'find\t',
  'wc ', 'wc\t', 'head ', 'head\t', 'tail ', 'tail\t',
  'which ', 'which\t', 'type ', 'type\t',
  'echo ', 'echo\t',
  'jq ', 'jq\t',
  'npx tsc --noEmit', 'npx tsc--noEmit',
];

/**
 * Returns true when a Bash command is read-only (no side effects).
 * Used to force type_override = 'discovery' so investigation commands
 * are not misclassified as bugfix or feature by the LLM capture agent.
 */
function isBashReadOnly(command: string): boolean {
  // Output redirection always writes a file — not read-only regardless of the command.
  if (/>{1,2}/.test(command)) return false;

  const trimmed = command.trimStart();

  return READ_ONLY_BASH_PREFIXES.some(prefix => trimmed.startsWith(prefix))
    || trimmed === 'ls'
    || trimmed === 'git status'
    || trimmed === 'git log'
    || trimmed === 'git diff'
    || trimmed === 'git branch'
    || trimmed === 'git stash list';
}

/**
 * Commands where the second positional arg (after flags) is the search pattern,
 * not a file path — so the file paths start from the third positional arg.
 */
const PATTERN_FIRST_COMMANDS = new Set(['grep', 'rg']);

/**
 * Extracts file/directory paths from common read-only Bash commands.
 * Only handles the happy-path: single-segment commands (no pipes), simple flags.
 * Returns an empty array when the command is too complex to parse safely.
 */
export function extractBashFilesRead(command: string): string[] {
  // Only parse the first pipeline segment — pipes produce intermediate results,
  // not file reads from the perspective of this session.
  const segment = command.split('|')[0].trim();
  const tokens = segment.split(/\s+/).filter(Boolean);

  if (tokens.length < 2) return [];

  const cmd = tokens[0];

  // git commands are opaque — no file path to extract reliably.
  if (cmd === 'git') return [];

  const positional: string[] = [];
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith('-')) {
      // Skip flags that consume a numeric value argument (e.g. -n 20, -A 3)
      // Only skip when the next token is a bare number — otherwise it's a file path.
      const nextToken = i + 1 < tokens.length ? tokens[i + 1] : '';
      const nextIsNumeric = /^\d+$/.test(nextToken);
      const flagConsumesValue = /^-[nABCmle]$/.test(token) || token === '--include' || token === '--exclude';

      if (flagConsumesValue && nextIsNumeric) {
        i += 2;
      } else {
        i += 1;
      }
    } else {
      positional.push(token);
      i += 1;
    }
  }

  if (PATTERN_FIRST_COMMANDS.has(cmd)) {
    // positional[0] is the search pattern; file paths start at positional[1]
    return positional.slice(1);
  }

  return positional;
}

/**
 * Extracts destination file paths from common Bash write commands.
 * Handles output redirection, sed -i, mv/cp (destination), tee, rm, touch.
 * Returns an empty array when the command is too complex to parse safely.
 */
export function extractBashFilesModified(command: string): string[] {
  const segment = command.split('|')[0].trim();

  // Output redirection: `cmd > file` or `cmd >> file`
  // Match last occurrence so `cat a > b > c` resolves to the final target.
  const redirectMatch = segment.match(/>{1,2}\s*(\S+)\s*$/);
  if (redirectMatch) {
    return [redirectMatch[1]];
  }

  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];

  const cmd = tokens[0];
  let hasInPlace = false;

  const positional: string[] = [];
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith('-')) {
      // sed -i[suffix] flag — marks in-place edit
      if (token === '-i' || /^-i./.test(token)) {
        hasInPlace = true;
      }
      i += 1;
    } else {
      positional.push(token);
      i += 1;
    }
  }

  switch (cmd) {
    case 'sed':
      // sed -i 's/pattern/replace/' file...
      // positional[0] is the expression, rest are files
      return hasInPlace && positional.length >= 2 ? positional.slice(1) : [];

    case 'mv':
    case 'cp':
      // last positional is the destination
      return positional.length > 0 ? [positional[positional.length - 1]] : [];

    case 'tee':
    case 'rm':
    case 'touch':
      return positional;

    default:
      return [];
  }
}

function getStringField(obj: object, field: string): string | undefined {
  const value = (obj as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Tool inputs arrive either as parsed objects or as JSON strings — the pending
 * message store serializes them to TEXT, so messages replayed from the queue
 * carry strings. Parse defensively so both shapes yield the same extraction.
 */
function normalizeToolInput(raw: unknown): object {
  if (typeof raw === 'object' && raw !== null) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Malformed JSON is treated as no-input; metadata will be empty.
    }
  }
  return {};
}
