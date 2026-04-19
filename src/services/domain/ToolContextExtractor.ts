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

    case 'Bash':
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
