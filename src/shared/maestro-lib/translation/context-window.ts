import { formatCount } from '../../formatters';
import type { PortableRecord, TranslationPlan } from './types';

/** Legacy checkpoints predate window flags and carry every record. */
export function activeContextRecords(records: readonly PortableRecord[]): PortableRecord[] {
	return records.filter((record) => record.window !== 'archived');
}

/** Renderer-safe plan copy, including plans saved before window counts existed. */
export function formatTranslationRecordCounts(
	tab: Pick<TranslationPlan['tabs'][number], 'records' | 'activeRecords' | 'archivedRecords'>
): string {
	const archived = tab.archivedRecords ?? 0;
	const carried = tab.activeRecords ?? tab.records - archived;
	return `${formatCount(carried)} records carried${
		archived ? `, ${formatCount(archived)} archived before the last compaction` : ''
	}`;
}
