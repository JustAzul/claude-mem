import { workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import type { MemoryAssistReport } from '../../shared/memory-assist.js';

export async function reportMemoryAssist(report: MemoryAssistReport): Promise<void> {
  try {
    await workerHttpRequest('/api/memory-assist/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (error) {
    logger.debug('HOOK', 'Memory assist report unavailable', {
      error: error instanceof Error ? error.message : String(error),
      source: report.source,
      status: report.status,
      reason: report.reason,
    });
  }
}
