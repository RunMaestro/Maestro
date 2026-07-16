export interface TimestampedUsageSnapshot {
	sampledAt: string;
}

export interface UsageSnapshotStore {
	get(key: string, defaultValue?: unknown): unknown;
	set(key: string, value: unknown): void;
}

interface UsageSnapshotEnvelopeOptions<Snapshot extends TimestampedUsageSnapshot> {
	version: number;
	ttlMs: number;
	getKey: (snapshot: Snapshot) => string;
}

/**
 * Owns only the persistence mechanics shared by usage snapshot providers:
 * schema-version safety, retention, and keyed merge. Provider sampling and
 * payload validation remain in their respective stores.
 */
export function createUsageSnapshotEnvelope<Snapshot extends TimestampedUsageSnapshot>(
	options: UsageSnapshotEnvelopeOptions<Snapshot>
) {
	function readLiveSnapshots(
		store: UsageSnapshotStore,
		now = Date.now()
	): Record<string, Snapshot> {
		const storedVersion = store.get('version');
		if (storedVersion !== undefined && storedVersion !== options.version) {
			return {};
		}

		const storedSnapshots = store.get('snapshots', {});
		if (!isRecord(storedSnapshots)) {
			return {};
		}

		const live: Record<string, Snapshot> = {};
		let prunedAny = false;
		for (const [key, candidate] of Object.entries(storedSnapshots)) {
			if (isLiveSnapshot<Snapshot>(candidate, now, options.ttlMs)) {
				live[key] = candidate;
			} else {
				prunedAny = true;
			}
		}
		if (prunedAny) {
			store.set('snapshots', live);
		}
		return live;
	}

	return {
		getAll(store: UsageSnapshotStore, now?: number): Record<string, Snapshot> {
			return readLiveSnapshots(store, now);
		},
		get(store: UsageSnapshotStore, key: string, now?: number): Snapshot | null {
			return readLiveSnapshots(store, now)[key] ?? null;
		},
		set(store: UsageSnapshotStore, snapshot: Snapshot, now?: number): void {
			const snapshots = readLiveSnapshots(store, now);
			store.set('version', options.version);
			store.set('snapshots', { ...snapshots, [options.getKey(snapshot)]: snapshot });
		},
		clear(store: UsageSnapshotStore): void {
			store.set('version', options.version);
			store.set('snapshots', {});
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLiveSnapshot<Snapshot extends TimestampedUsageSnapshot>(
	value: unknown,
	now: number,
	ttlMs: number
): value is Snapshot {
	if (!isRecord(value) || typeof value.sampledAt !== 'string') {
		return false;
	}
	const sampledAtMs = new Date(value.sampledAt).getTime();
	return !Number.isNaN(sampledAtMs) && now - sampledAtMs <= ttlMs;
}
