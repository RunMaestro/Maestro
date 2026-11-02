import type {
	ContextualMemory,
	MemoryRecallIntent,
	MemorySupport,
} from '../../shared/pianola/memory';

/** Validate untrusted bridge/model intent; never broaden a malformed selector. */
export function validateMemoryRecallIntent(value: unknown): MemoryRecallIntent {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid memory recall intent');
	const record = value as Record<string, unknown>;
	if (record.mode === 'as-of') {
		const date =
			typeof record.at === 'string' &&
			record.at.match(
				/^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
			);
		if (
			Object.keys(record).some((key) => key !== 'mode' && key !== 'at') ||
			!date ||
			!Number.isFinite(Date.parse(String(record.at))) ||
			new Date(date[1]).toISOString().slice(0, 10) !== date[1]
		)
			throw new Error('Invalid memory as-of intent');
		return { mode: 'as-of', at: new Date(String(record.at)).toISOString() };
	}
	if (
		Object.keys(record).some((key) => key !== 'mode') ||
		typeof record.mode !== 'string' ||
		!['current', 'previous', 'proposed', 'contested', 'history'].includes(record.mode)
	)
		throw new Error('Invalid or conflicting memory recall intent');
	return { mode: record.mode as Exclude<MemoryRecallIntent['mode'], 'as-of'> };
}

/** Half-open validity. Previous/history may look backwards, never into future-effective rows. */
export function memoryIsEligible(
	memory: Pick<ContextualMemory, 'status' | 'validFrom' | 'validTo'>,
	intent: MemoryRecallIntent = { mode: 'current' },
	now = Date.now()
): boolean {
	intent = validateMemoryRecallIntent(intent);
	const at = intent.mode === 'as-of' ? Date.parse(intent.at) : now;
	if (!Number.isFinite(at)) throw new Error('Invalid memory as-of time');
	const from = memory.validFrom === null ? -Infinity : Date.parse(memory.validFrom);
	const to = memory.validTo === null ? Infinity : Date.parse(memory.validTo);
	if (Number.isNaN(from) || Number.isNaN(to) || from >= to || at < from) return false;
	if (intent.mode === 'history') return true;
	if (intent.mode === 'previous')
		return memory.status === 'superseded' || (memory.status === 'current' && to <= at);
	if (at >= to) return false;
	if (intent.mode === 'as-of')
		return (
			memory.status === 'current' || (memory.status === 'superseded' && memory.validTo !== null)
		);
	return memory.status === intent.mode;
}

/** Date strings are normalized before comparison/storage; never silently discard bad bounds. */
export function memoryDate(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
		throw new Error('Invalid memory validity date');
	return new Date(value).toISOString();
}

export function validateMemoryInterval(from: string | null, to: string | null): void {
	if (from !== null && to !== null && from >= to)
		throw new Error('Memory validity must be a nonempty half-open interval');
}

/** Proposal identity includes modality, even when the literal claim is identical. */
export function sameMemorySlot(a: ContextualMemory, b: ContextualMemory): boolean {
	return (
		a.userId === b.userId &&
		a.projectId === b.projectId &&
		a.kind === b.kind &&
		a.status !== 'superseded' &&
		b.status !== 'superseded' &&
		(a.status === 'proposed') === (b.status === 'proposed')
	);
}

const supportRank: Record<MemorySupport, number> = {
	unverified: 0,
	inferred: 1,
	observed: 2,
	explicit: 3,
};

/** Keep canonical identity/text. Newer equally-or-better-supported metadata wins;
 * stale/weaker assertions add evidence/links only. Alternatives union when metadata wins.
 * Pinning is sticky: extraction cannot perform the separate explicit unpin operation.
 */
export function mergeMemoryDuplicate(
	existing: ContextualMemory,
	incoming: ContextualMemory
): ContextualMemory {
	if (!sameMemorySlot(existing, incoming))
		throw new Error('Memory duplicate changes assertion slot or modality');
	const metadataWins =
		supportRank[incoming.support] >= supportRank[existing.support] &&
		(existing.validFrom === null ||
			(incoming.validFrom !== null && incoming.validFrom >= existing.validFrom));
	const evidence = new Map(existing.evidence.map((e) => [e.id, e]));
	for (const e of incoming.evidence) evidence.set(e.id, e);
	const merged = {
		...existing,
		...(metadataWins ? incoming : {}),
		id: existing.id,
		text: existing.text,
		learnedAt: Math.max(existing.learnedAt, incoming.learnedAt),
		pinned: existing.pinned || incoming.pinned,
		alternatives: metadataWins
			? [...new Set([...existing.alternatives, ...incoming.alternatives])]
			: existing.alternatives,
		evidence: [...evidence.values()],
		related: [...new Set([...existing.related, ...incoming.related])].filter(
			(id) => id !== existing.id
		),
		duplicateOf: existing.id,
	};
	if (merged.supersedes === existing.id) merged.supersedes = existing.supersedes;
	merged.related = merged.related.filter((id) => id !== merged.supersedes);
	// Repeating a claim is not evidence that its surviving conflicts were resolved.
	if (existing.status === 'contested' && merged.status === 'current' && merged.related.length)
		merged.status = 'contested';
	return merged;
}

/** A supplied link alone is not evidence of a correction or user approval. */
export function hasCorrectionEvidence(memory: ContextualMemory): boolean {
	return memory.evidence.some(
		(e) =>
			(memory.support === 'explicit' && e.role === 'user' && e.attribution === 'human') ||
			(memory.support === 'observed' &&
				['tool', 'assistant'].includes(e.role) &&
				e.attribution !== 'human' &&
				['project', 'episode', 'context'].includes(memory.kind)) ||
			(memory.status === 'proposed' &&
				e.role === 'assistant' &&
				e.attribution === 'automated' &&
				(!e.authorship || e.authorship === 'assistant') &&
				((typeof e.sourceId === 'string' && e.sourceId.startsWith('explicit:')) ||
					e.provenance === 'conversation'))
	);
}
