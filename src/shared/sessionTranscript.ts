export interface SessionTranscriptPatch<T extends { id: string } = { id: string }> {
	sessionId: string;
	tabId?: string;
	field: 'logs' | 'aiLogs' | 'shellLogs';
	upserts: T[];
	removedIds: string[];
	orderIds: string[];
	/** A requested owning-renderer snapshot replaces the projected log array. */
	snapshot?: boolean;
	runtime?: Record<string, unknown>;
	clearRuntimeFields?: string[];
}

/** Row identity comes from the owning renderer, never from text or timestamps. */
export function applySessionTranscriptPatch<T extends { id: string }>(
	logs: T[],
	patch: SessionTranscriptPatch<T>
): T[] {
	const removed = new Set(patch.removedIds);
	const byId = new Map(
		(patch.snapshot ? [] : logs).filter((row) => !removed.has(row.id)).map((row) => [row.id, row])
	);
	for (const row of patch.upserts) byId.set(row.id, row);
	const result: T[] = [];
	for (const id of patch.orderIds) {
		const row = byId.get(id);
		if (row) {
			result.push(row);
			byId.delete(id);
		}
	}
	result.push(...byId.values());
	return result;
}
