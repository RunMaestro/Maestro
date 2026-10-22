// Persistence deltas are based on the snapshot this client actually observed.
// A stale full-session flush must not erase a peer's tabs, transcript or queue.
type RecordData = Record<string, any>;
const same = (a: unknown, b: unknown): boolean =>
	a === b || JSON.stringify(a) === JSON.stringify(b);

const clientFields: Record<string, true> = {
	activeTabId: true,
	activeFileTabId: true,
	activeBrowserTabId: true,
	activeTerminalTabId: true,
	activeGroupId: true,
	inputMode: true,
	inputValue: true,
	commandMode: true,
	stagedImages: true,
	terminalDraftInput: true,
	ptyInitialized: true,
};
const liveFields: Record<string, true> = {
	state: true,
	busySource: true,
	thinkingStartTime: true,
	thinking: true,
	thinkingLogId: true,
	currentCycleTokens: true,
	currentCycleBytes: true,
	pid: true,
	agentError: true,
	agentErrorPaused: true,
	agentErrorTabId: true,
	ptyInitialized: true,
};
const rows: Record<string, true> = {
	aiTabs: true,
	logs: true,
	aiLogs: true,
	shellLogs: true,
	executionQueue: true,
	filePreviewTabs: true,
	browserTabs: true,
	terminalTabs: true,
	snoozedTabs: true,
	members: true,
	unifiedTabOrder: true,
};

// These fields describe one native slot. A provider switch must never merge a
// pin from one client with another client's native ID or parked selections.
const tabProviderFields = [
	'tabProvider',
	'agentSessionId',
	'providerSessions',
	'pendingTranslation',
	'usageStats',
	'customModel',
	'customEffort',
	'runOn',
	'awaitingSessionId',
] as const;
const tabIdentityFields = [
	'tabProvider',
	'agentSessionId',
	'providerSessions',
	'pendingTranslation',
] as const;

function mergeRows(
	incoming: RecordData[],
	stored: RecordData[],
	baseline: RecordData[],
	preserveClient: boolean,
	preserveLive: boolean,
	aiTabs: boolean
): RecordData[] {
	const key = (row: RecordData): string => (row.type ? `${row.type}:${row.id}` : row.id);
	if ([...incoming, ...stored, ...baseline].some((row) => !row || typeof row.id !== 'string')) {
		return same(stored, baseline) ? incoming : stored;
	}
	const before = new Map(baseline.map((row) => [key(row), row]));
	const next = new Map(incoming.map((row) => [key(row), row]));
	const result: RecordData[] = [];
	for (const current of stored) {
		const id = key(current);
		const change = next.get(id);
		const base = before.get(id);
		if (change) {
			result.push(
				mergeRecord(change, current, base ?? current, preserveClient, preserveLive, aiTabs)
			);
			next.delete(id);
		} else if (!base || !same(current, base)) {
			// A peer added/edited this row after the caller's snapshot.
			result.push(current);
		}
	}
	for (const [id, change] of next) {
		// A row missing from stored but present in baseline was removed by a peer.
		if (before.has(id)) continue;
		if (
			preserveClient &&
			('inputValue' in change || (!preserveLive && 'ptyInitialized' in change))
		) {
			const addition = { ...change };
			if ('inputValue' in change) {
				addition.inputValue = '';
				addition.commandMode = undefined;
				addition.stagedImages = [];
			}
			// A persisted client-created terminal is not proof of a host PTY.
			if (!preserveLive) delete addition.ptyInitialized;
			result.push(addition);
		} else result.push(change);
	}
	// Respect this client's drag order/insertion positions only if the host has
	// not independently reordered the observed rows. Peer-only rows keep their
	// existing slots; removed rows are never revived by a stale drag operation.
	const storedIds = new Set(stored.map(key));
	const baselineOrder = baseline.filter((row) => storedIds.has(key(row))).map(key);
	const storedOrder = stored.filter((row) => before.has(key(row))).map(key);
	if (same(storedOrder, baselineOrder)) {
		const merged = new Map(result.map((row) => [key(row), row]));
		const incomingIds = new Set(incoming.map(key));
		const ordered = incoming
			.map((row) => merged.get(key(row)))
			.filter((row): row is RecordData => row !== undefined);
		let index = 0;
		return result.map((row) => (incomingIds.has(key(row)) ? ordered[index++] : row));
	}
	return result;
}

function mergeRecord(
	incoming: RecordData,
	stored: RecordData,
	baseline: RecordData,
	preserveClient: boolean,
	preserveLive: boolean,
	aiTab = false
): RecordData {
	const result = { ...stored };
	const slotChanged =
		aiTab &&
		tabIdentityFields.some(
			(field) => !same(incoming[field], baseline[field]) || !same(stored[field], baseline[field])
		);
	if (slotChanged && tabProviderFields.every((field) => same(stored[field], baseline[field]))) {
		for (const field of tabProviderFields) {
			if (incoming[field] === undefined) delete result[field];
			else result[field] = incoming[field];
		}
	}
	for (const field of new Set([...Object.keys(incoming), ...Object.keys(baseline)])) {
		if (
			field === 'deferredContent' ||
			(slotChanged && (tabProviderFields as readonly string[]).includes(field)) ||
			(preserveClient && clientFields[field]) ||
			(preserveLive && liveFields[field])
		)
			continue;
		const change = incoming[field];
		const current = stored[field];
		const before = baseline[field];
		if (same(change, before)) continue;
		if (rows[field] && Array.isArray(change)) {
			result[field] = mergeRows(
				change,
				Array.isArray(current) ? current : [],
				Array.isArray(before) ? before : [],
				preserveClient,
				preserveLive,
				field === 'aiTabs'
			);
		} else if (field === 'tab' && change && current && before) {
			result[field] = mergeRecord(
				change,
				current,
				before,
				preserveClient,
				preserveLive,
				incoming.type === 'ai'
			);
		} else if (same(current, before)) {
			if (change === undefined) delete result[field];
			else result[field] = change;
		}
	}
	return result;
}

/** Apply only observed session changes; conflicts retain the newer stored value. */
export function mergeSessionPersistenceChanges<T extends RecordData>(
	incoming: T,
	stored: T | undefined,
	baseline: T | undefined,
	preserveClient = false,
	preserveLive = false
): T {
	if (!stored || !baseline) return incoming;
	return mergeRecord(incoming, stored, baseline, preserveClient, preserveLive) as T;
}
