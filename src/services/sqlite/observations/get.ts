/**
 * Observation retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';
import type { GetObservationsByIdsOptions, ObservationSessionRow } from './types.js';

/**
 * Get a single observation by ID
 */
export function getObservationById(db: Database, id: number): ObservationRecord | null {
  const stmt = db.prepare(`
    SELECT *
    FROM observations
    WHERE id = ?
  `);

  return stmt.get(id) as ObservationRecord | undefined || null;
}

/**
 * Get observations by array of IDs with ordering and limit
 */
export function getObservationsByIds(
  db: Database,
  ids: number[],
  options: GetObservationsByIdsOptions = {}
): ObservationRecord[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';

  // Build placeholders for IN clause
  const placeholders = ids.map(() => '?').join(',');
  const params: any[] = [...ids];
  const additionalConditions: string[] = [];

  // Apply project filter
  if (project) {
    additionalConditions.push('project = ?');
    params.push(project);
  }

  // Apply type filter
  if (type) {
    if (Array.isArray(type)) {
      const typePlaceholders = type.map(() => '?').join(',');
      additionalConditions.push(`type IN (${typePlaceholders})`);
      params.push(...type);
    } else {
      additionalConditions.push('type = ?');
      params.push(type);
    }
  }

  // Apply concepts filter
  if (concepts) {
    const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
    const conceptConditions = conceptsList.map(() =>
      'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
    );
    params.push(...conceptsList);
    additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
  }

  // Apply files filter
  if (files) {
    const filesList = Array.isArray(files) ? files : [files];
    const fileConditions = filesList.map(() => {
      return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
    });
    filesList.forEach(file => {
      params.push(`%${file}%`, `%${file}%`);
    });
    additionalConditions.push(`(${fileConditions.join(' OR ')})`);
  }

  const whereClause = additionalConditions.length > 0
    ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
    : `WHERE id IN (${placeholders})`;

  const stmt = db.prepare(`
    SELECT *
    FROM observations
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...params) as ObservationRecord[];
}

/**
 * Get observations for a specific session
 */
export function getObservationsForSession(
  db: Database,
  memorySessionId: string
): ObservationSessionRow[] {
  const stmt = db.prepare(`
    SELECT title, subtitle, type, prompt_number
    FROM observations
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch ASC
  `);

  return stmt.all(memorySessionId) as ObservationSessionRow[];
}

/**
 * Get observations associated with a given file path, scoped to specific projects.
 * Matches on the full file path (not just basename) to avoid cross-project collisions.
 */
export function getObservationsByFilePath(
  db: Database,
  filePath: string,
  options?: { projects?: string[]; limit?: number }
): ObservationRecord[] {
  const rawLimit = options?.limit;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
    ? Math.min(rawLimit as number, 100)
    : 15;

  // files_read / files_modified store absolute paths (captured via tool_input)
  // but callers (file_context hook) pass a relative path resolved against cwd.
  // Exact equality (`value = ?`) was failing on that mismatch, producing
  // `no_observations` for files that in fact had abundant memory — empirical
  // audit found `src/services/sqlite/memory-assist/dashboard.ts` returning 0
  // results while 20 stored observations referenced the absolute form of the
  // same path. Substring LIKE matches either form and is further guarded by
  // the JSON array structure + project filter.
  const likePattern = `%${filePath}%`;
  const params: (string | number)[] = [likePattern, likePattern];

  let projectClause = '';
  if (options?.projects?.length) {
    const placeholders = options.projects.map(() => '?').join(',');
    projectClause = `AND project IN (${placeholders})`;
    params.push(...options.projects);
  }

  params.push(limit);

  const stmt = db.prepare(`
    SELECT *
    FROM observations
    WHERE (
      (files_read LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?))
      OR (files_modified LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))
    )
    ${projectClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  const directResults = (stmt.all(...params) as ObservationRecord[]).map(r => ({ ...r, via: 'direct' as const }));

  // If primary results fill the budget, skip cross-ref expansion
  if (directResults.length >= limit) {
    return directResults.slice(0, limit);
  }

  // Collect candidate IDs from related_observation_ids of direct results
  const directIdSet = new Set(directResults.map(r => r.id));
  const hopCandidateIds = new Set<number>();
  for (const row of directResults) {
    const raw = row.related_observation_ids;
    if (!raw || typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const id of parsed) {
        if (Number.isInteger(id) && id > 0 && !directIdSet.has(id)) {
          hopCandidateIds.add(id);
        }
      }
    } catch (error: unknown) {
      logger.debug('OBSERVATIONS', 'Failed to parse related_observation_ids for cross-ref hop', { observationId: row.id });
    }
  }

  if (hopCandidateIds.size === 0) return directResults;

  // Budget remaining after direct results
  const remaining = limit - directResults.length;
  const hopIds = [...hopCandidateIds].slice(0, remaining);
  const hopPlaceholders = hopIds.map(() => '?').join(',');

  let hopProjectClause = '';
  const hopParams: (string | number)[] = [...hopIds];
  if (options?.projects?.length) {
    const projPh = options.projects.map(() => '?').join(',');
    hopProjectClause = `AND project IN (${projPh})`;
    hopParams.push(...options.projects);
  }

  const hopStmt = db.prepare(`
    SELECT *
    FROM observations
    WHERE id IN (${hopPlaceholders}) ${hopProjectClause}
    ORDER BY created_at_epoch DESC
  `);

  const hopResults = (hopStmt.all(...hopParams) as ObservationRecord[]).map(r => ({ ...r, via: 'cross_ref' as const }));

  return [...directResults, ...hopResults];
}
