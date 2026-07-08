import type { LogEntry } from '../../../types';

export const isHiddenProgressEntry = (log: LogEntry): boolean =>
	log.source === 'system' && log.id.startsWith('hidden-progress:');
