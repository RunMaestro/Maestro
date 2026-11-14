import { recordKey, nativeRecordKey } from './identity';
import type { PortableConversation, TranslationCheckpoint, TranslationLimitation } from './types';

/** Append-only native checkpoints, plus imported lineage, prevent round-trip echoes. */
export function reconcileConversation(
	incoming: PortableConversation,
	checkpoint?: TranslationCheckpoint
): {
	conversation: PortableConversation;
	newRecords: number;
	limitations: TranslationLimitation[];
} {
	const previous = checkpoint?.conversations.find((c) => c.tabId === incoming.tabId);
	const records = [...(previous?.records ?? [])];
	const known = new Map(records.map((r) => [recordKey(r.origin), r]));
	const canonicalRecords = new Map(
		checkpoint?.conversations.flatMap((c) => c.records).map((r) => [recordKey(r.origin), r]) ?? []
	);
	const limitations = [...incoming.limitations];
	const observed = new Set<string>();
	const windows = new Map<string, 'active' | 'archived'>();
	let newRecords = 0;
	for (const record of incoming.records) {
		const nativeKey = nativeRecordKey(
			incoming.identity,
			incoming.nativeSessionId ?? '',
			record.nativeId
		);
		observed.add(nativeKey);
		const oldHash = checkpoint?.observed[nativeKey];
		if (oldHash && oldHash !== record.semanticHash) {
			limitations.push({
				code: 'edited-native-record',
				severity: 'block',
				tabId: incoming.tabId,
				message: `Native record ${record.nativeId} changed after the shared checkpoint.`,
			});
		}
		const lineage = checkpoint?.lineage[nativeKey];
		const original = lineage ?? record.origin;
		const key = recordKey(original);
		// One original record can project to several native items. Any active item
		// keeps its origin active; archived items alone must not resurrect it.
		if (windows.get(key) !== 'active') windows.set(key, record.window ?? 'active');
		// A foreign representation hashes differently. Native edits are checked above.
		if (known.has(key)) continue;
		const canonical = canonicalRecords.get(key);
		const next = canonical ? { ...canonical, origin: original } : { ...record, origin: original };
		records.push(next);
		known.set(key, next);
		newRecords++;
	}
	if (checkpoint && incoming.nativeSessionId) {
		for (const key of Object.keys(checkpoint.observed)) {
			const origin = JSON.parse(key) as { provider: string; account: string; sessionId: string };
			if (
				origin.provider === incoming.identity.provider &&
				origin.sessionId === incoming.nativeSessionId &&
				key === nativeRecordKey(incoming.identity, origin.sessionId, JSON.parse(key).eventId) &&
				!observed.has(key)
			) {
				limitations.push({
					code: 'truncated-native-history',
					severity: 'block',
					tabId: incoming.tabId,
					message:
						'Previously observed native history was deleted or compacted. Recover the retained branch before switching.',
				});
				break;
			}
		}
	}
	const artifacts = new Map((previous?.artifacts ?? []).map((a) => [a.id, a]));
	for (const artifact of incoming.artifacts) artifacts.set(artifact.id, artifact);
	const hasCompaction = incoming.records.some((record) => record.boundary === 'compaction');
	return {
		conversation: {
			...incoming,
			// Preserve all canonical evidence and identities, but refresh window
			// membership even for known records. Unrepresented checkpoint evidence
			// stays archived when the current provider has compacted its context.
			records: records.map((record) => ({
				...record,
				window:
					windows.get(recordKey(record.origin)) ?? (hasCompaction ? 'archived' : record.window),
			})),
			artifacts: [...artifacts.values()],
			limitations,
		},
		newRecords,
		limitations,
	};
}

/** Absence is a deletion, including when one side was never changed. Conflicts retain both sides. */
export function reconcileResource(
	base: string | null,
	source: string | null,
	destination: string | null
): {
	state: 'unchanged' | 'source' | 'destination' | 'conflict';
	value: string | null;
	variants?: [string | null, string | null];
} {
	if (source === destination) return { state: 'unchanged', value: source };
	if (destination === base) return { state: 'source', value: source };
	if (source === base) return { state: 'destination', value: destination };
	return { state: 'conflict', value: base, variants: [source, destination] };
}
