
import path from 'path';
import type { MemoryAssistTraceItem } from './memory-assist.js';
import { logger } from '../utils/logger.js';

export function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    logger.debug('PARSER', 'Failed to parse JSON array, using empty fallback', {
      preview: json?.substring(0, 50)
    }, err instanceof Error ? err : new Error(String(err)));
    return [];
  }
}

export function formatDateTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

export function formatTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

export function formatDate(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }
  return filePath;
}

export function extractFirstFile(
  filesModified: string | null,
  cwd: string,
  filesRead?: string | null
): string {
  const modified = parseJsonArray(filesModified);
  if (modified.length > 0) {
    return toRelativePath(modified[0], cwd);
  }

  if (filesRead) {
    const read = parseJsonArray(filesRead);
    if (read.length > 0) {
      return toRelativePath(read[0], cwd);
    }
  }

  return 'General';
}

export function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTimelineTokensFromTraceItems(
  traceItems: MemoryAssistTraceItem[] | null | undefined,
  filePath?: string | null
): number {
  if (!traceItems?.length) return 0;

  const dayBuckets = new Set(
    traceItems
      .map((item) => (item.createdAtEpoch ? formatDate(item.createdAtEpoch) : null))
      .filter((value): value is string => Boolean(value))
  );

  const header = [
    `This file has prior observations. ${filePath ? `File: ${path.basename(filePath)}.` : ''}`.trim(),
    '- Already know enough? The timeline below may be all you need.',
    '- Need details? get_observations([IDs]).',
  ];

  const rows = traceItems.map((item) => {
    const datePrefix = item.createdAtEpoch ? formatTime(item.createdAtEpoch) : '';
    const title = (item.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${item.observationId} ${datePrefix} ${item.type ?? 'discovery'} ${title}`.trim();
  });

  const approxText = [
    ...header,
    ...Array.from(dayBuckets).map((day) => `### ${day}`),
    ...rows,
  ].join('\n');

  return estimateTokens(approxText);
}


export function groupByDate<T>(
  items: T[],
  getDate: (item: T) => string
): Map<string, T[]> {
  const itemsByDay = new Map<string, T[]>();
  for (const item of items) {
    const itemDate = getDate(item);
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day)!.push(item);
  }

  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
}
