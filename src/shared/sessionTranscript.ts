/** Creation evidence lives only in the creating process, never in a disk window.
 * Keying by the initial log array survives immutable tab spreads, but not hydration. */
const newEmptyLogs = new WeakSet<object>();
export function newEmptyTranscript<T>(): T[] {
	const logs: T[] = [];
	newEmptyLogs.add(logs);
	return logs;
}
export function consumeEmptyTranscriptCreation(logs: object): boolean {
	const created = newEmptyLogs.has(logs);
	newEmptyLogs.delete(logs);
	return created;
}

export interface SessionTranscriptPatch<T extends { id: string } = { id: string }> {
	/** Native observation metadata; omitted by older renderers and browser clients. */
	observation?: import('./currentTurn').TranscriptObservation;
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
	/** Private owner inventory, including tabs not yet flushed to disk. Never a live delta. */
	tabInventory?: Array<{ id: string; clearRuntimeFields?: string[]; [field: string]: unknown }>;
}

/** Private runtime hydration accompanies logs without duplicating their payload. */
export type SessionRuntimeSnapshot = Pick<
	SessionTranscriptPatch,
	'sessionId' | 'tabId' | 'runtime' | 'clearRuntimeFields'
>;

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
