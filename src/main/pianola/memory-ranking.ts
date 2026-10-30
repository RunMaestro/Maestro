import { isAbsolutePath } from '../../shared/formatters';
import type { MemoryCandidate } from './memory-candidates';
import type { MemoryRelevanceSelection } from './memory-relevance';

function paths(text: string): string[] {
	return (
		(
			text.match(
				/(?:[a-zA-Z]:)?(?:[\p{L}\p{N}_.-]*[/\\])+[\p{L}\p{N}_.-]*|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.[\p{L}][\p{L}\p{N}_-]*/gu
			) ?? []
		)
			.map((path) => path.replace(/\\/g, '/').replace(/\.+$/, ''))
			// Units such as requests/min are not file identities.
			.filter(
				(path) =>
					isAbsolutePath(path) || path.endsWith('/') || /\.[\p{L}][\p{L}\p{N}_-]*$/u.test(path)
			)
	);
}
function pathMatches(candidate: string, wanted: string): boolean {
	// Windows absolute paths are case-insensitive; relative/POSIX identities are not.
	if (/^[a-zA-Z]:\//.test(candidate)) {
		candidate = candidate.toLowerCase();
		wanted = wanted.toLowerCase();
	}
	if (candidate === wanted) return true;
	const absolute = isAbsolutePath(wanted);
	if (wanted.endsWith('/')) {
		return (
			candidate.startsWith(wanted) ||
			(!absolute && isAbsolutePath(candidate) && candidate.includes('/' + wanted))
		);
	}
	return (
		!absolute &&
		(!wanted.includes('/') || isAbsolutePath(candidate)) &&
		candidate.endsWith('/' + wanted)
	);
}
export function memoryCosineSimilarity(candidate: MemoryCandidate): number | null {
	const distance = candidate.cosineDistance;
	return distance !== undefined && Number.isFinite(distance) && distance >= 0 && distance <= 2
		? Math.max(-1, Math.min(1, 1 - distance))
		: null;
}
/** Same unweighted reciprocal-rank fusion used by the SQL channel collector (ranks are zero-based). */
function memoryReciprocalRankScore(candidate: MemoryCandidate): number {
	return (
		(candidate.lexicalRank === undefined ? 0 : 1 / (61 + candidate.lexicalRank)) +
		(candidate.vectorRank === undefined ? 0 : 1 / (61 + candidate.vectorRank))
	);
}
export function compareMemoryCandidateSimilarity(a: MemoryCandidate, b: MemoryCandidate): number {
	const left = memoryCosineSimilarity(a);
	const right = memoryCosineSimilarity(b);
	if (left !== right) {
		if (left === null) return 1;
		if (right === null) return -1;
		return right - left;
	}
	return memoryReciprocalRankScore(b) - memoryReciprocalRankScore(a);
}

/**
 * How much better the embedding must be before it wins outright.
 *
 * The lexical channel orders by BM25, which tracks how many distinct query terms a
 * row actually contains. That is a real signal, but the embedding's own ordering is
 * stronger when the embedding is confident. Inside this margin the two are close
 * enough that the lexical evidence should decide; beyond it, the embedding wins.
 */
const LEXICAL_PRIOR_MARGIN = 0.2;
/**
 * The largest amount the lexical evidence may move a contested candidate.
 *
 * The adjustment is bounded rather than a weighted blend, so a candidate with no
 * lexical overlap can only lose a little, and a clearly better embedding always
 * wins. An unbounded blend lets the lexical channel dominate, which demotes
 * relevant rows whose wording does not reuse the query's words.
 */
const LEXICAL_PRIOR_BOOST = 0.05;

/**
 * The lexical channel's evidence that this row matches the query.
 *
 * The BM25 score is the real measure: it falls sharply as more distinct query
 * terms are found. The rank is only a position, so it cannot tell a row that
 * matched every term from a row that matched one. The score is normalized across
 * the candidate set, so the best match scores 1 and the weakest 0.
 */
function lexicalPrior(
	candidate: MemoryCandidate,
	bestScore: number | null,
	worstScore: number | null
): number {
	if (candidate.lexicalScore === undefined) return 0;
	if (bestScore === null || worstScore === null) return 0;
	const spread = bestScore - worstScore;
	if (spread === 0) return candidate.lexicalScore === bestScore ? 1 : 0;
	// BM25 scores are negative and the best match is the most negative.
	return Math.max(0, Math.min(1, (candidate.lexicalScore - worstScore) / spread));
}

/**
 * Order candidates by a bounded lexical adjustment.
 *
 * A candidate whose embedding is clearly worse than the best in the set keeps its
 * cosine position. A candidate within the margin of the best is contested: the
 * lexical channel's BM25 ordering adjusts its score, but only within
 * LEXICAL_PRIOR_BOOST. This keeps a strong vector-only hit ahead of a weak
 * mixed-channel hit while letting exact-term evidence break the near-ties that a
 * small embedding cannot separate.
 */
export function compareMemoryCandidatesByGuardedPrior(
	a: MemoryCandidate,
	b: MemoryCandidate,
	bestCosine: number | null,
	bestLexicalScore: number | null = null,
	worstLexicalScore: number | null = null
): number {
	const left = memoryCosineSimilarity(a) ?? 0;
	const right = memoryCosineSimilarity(b) ?? 0;
	const leftContested = bestCosine === null || bestCosine - left <= LEXICAL_PRIOR_MARGIN;
	const rightContested = bestCosine === null || bestCosine - right <= LEXICAL_PRIOR_MARGIN;
	const leftScore = leftContested
		? left + LEXICAL_PRIOR_BOOST * (lexicalPrior(a, bestLexicalScore, worstLexicalScore) - 0.5)
		: left;
	const rightScore = rightContested
		? right + LEXICAL_PRIOR_BOOST * (lexicalPrior(b, bestLexicalScore, worstLexicalScore) - 0.5)
		: right;
	if (leftScore !== rightScore) return rightScore - leftScore;
	return compareMemoryCandidateSimilarity(a, b);
}
function validateLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recall limit');
}
/** Merge eligible channels semantically before the shortlist cap; similarity is not factual proof. */
export function shortlistMemoryCandidates(
	candidates: MemoryCandidate[],
	query: string,
	limit = 40
): MemoryCandidate[] {
	validateLimit(limit);
	if (!query.trim()) return [];
	const wantedPaths = paths(query);
	const seen = new Set<string>();
	const result: MemoryCandidate[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.memory.id)) continue;
		seen.add(candidate.memory.id);
		if (wantedPaths.length) {
			const candidatePaths = paths(
				[
					candidate.memory.text,
					candidate.memory.rationale ?? '',
					...(candidate.memory.alternatives ?? []),
				].join('\n')
			);
			if (!wantedPaths.some((wanted) => candidatePaths.some((path) => pathMatches(path, wanted))))
				continue;
		}
		result.push(candidate);
	}
	const bestCosine = result.reduce<number | null>((best, candidate) => {
		const cosine = memoryCosineSimilarity(candidate);
		if (cosine === null) return best;
		return best === null || cosine > best ? cosine : best;
	}, null);
	const lexicalScores = result
		.map((candidate) => candidate.lexicalScore)
		.filter((score): score is number => score !== undefined);
	const bestLexicalScore = lexicalScores.length ? Math.min(...lexicalScores) : null;
	const worstLexicalScore = lexicalScores.length ? Math.max(...lexicalScores) : null;
	result.sort(
		(a, b) =>
			compareMemoryCandidatesByGuardedPrior(
				a,
				b,
				bestCosine,
				bestLexicalScore,
				worstLexicalScore
			) || metadataOrder(a, b)
	);
	result.length = Math.min(result.length, limit);
	return result;
}
const STATUS_ORDER: Record<MemoryCandidate['memory']['status'], number> = {
	current: 3,
	proposed: 2,
	contested: 1,
	superseded: 0,
};
const SUPPORT_ORDER: Record<MemoryCandidate['memory']['support'], number> = {
	explicit: 3,
	observed: 2,
	inferred: 1,
	unverified: 0,
};
function metadataOrder(a: MemoryCandidate, b: MemoryCandidate): number {
	return (
		STATUS_ORDER[b.memory.status] - STATUS_ORDER[a.memory.status] ||
		Number(b.memory.pinned) - Number(a.memory.pinned) ||
		SUPPORT_ORDER[b.memory.support] - SUPPORT_ORDER[a.memory.support] ||
		b.memory.learnedAt - a.memory.learnedAt
	);
}
function rerankOrder(a: MemoryCandidate, b: MemoryCandidate): number {
	if (a.rerankScore === undefined && b.rerankScore === undefined) return 0;
	if (a.rerankScore === undefined) return 1;
	if (b.rerankScore === undefined) return -1;
	return b.rerankScore - a.rerankScore;
}
function normalizeAssertion(text: string): string {
	const normalized = text.trim().replace(/\s+/g, ' ');
	return paths(normalized).length ? normalized : normalized.toLowerCase();
}
/** Only selected facts enter; semantic relevance precedes all metadata, dedup precedes final top-k. */
export function rankRelevantMemoryCandidates(
	candidates: MemoryCandidate[],
	selections: MemoryRelevanceSelection[],
	limit = 8
): MemoryCandidate[] {
	validateLimit(limit);
	const byId = new Map(candidates.map((candidate) => [candidate.memory.id, candidate]));
	const selected = new Set<string>();
	const ranked = selections.map((selection) => {
		const candidate = byId.get(selection.id);
		if (
			!candidate ||
			selected.has(selection.id) ||
			(selection.relevance !== 1 && selection.relevance !== 2)
		) {
			throw new Error('Invalid memory relevance selection');
		}
		selected.add(selection.id);
		return { candidate, relevance: selection.relevance };
	});
	ranked.sort(
		(a, b) =>
			b.relevance - a.relevance ||
			rerankOrder(a.candidate, b.candidate) ||
			metadataOrder(a.candidate, b.candidate)
	);
	const assertions = new Set<string>();
	// Keep the existing reviewed/metadata-preferred representative of each assertion.
	let uniqueCount = 0;
	for (const row of ranked) {
		const m = row.candidate.memory;
		const key = JSON.stringify([
			m.userId,
			m.projectId,
			m.kind,
			m.support,
			m.status,
			m.validFrom,
			m.validTo,
			normalizeAssertion(m.text),
			normalizeAssertion(m.rationale ?? ''),
			(m.alternatives ?? []).map(normalizeAssertion),
		]);
		if (assertions.has(key)) continue;
		assertions.add(key);
		ranked[uniqueCount++] = row;
	}
	ranked.length = uniqueCount;
	const bestCosine = ranked.reduce<number | null>((best, row) => {
		const cosine = memoryCosineSimilarity(row.candidate);
		if (cosine === null) return best;
		return best === null || cosine > best ? cosine : best;
	}, null);
	const lexicalScores = ranked
		.map((row) => row.candidate.lexicalScore)
		.filter((score): score is number => score !== undefined);
	const bestLexicalScore = lexicalScores.length ? Math.min(...lexicalScores) : null;
	const worstLexicalScore = lexicalScores.length ? Math.max(...lexicalScores) : null;
	ranked.sort(
		(a, b) =>
			b.relevance - a.relevance ||
			rerankOrder(a.candidate, b.candidate) ||
			compareMemoryCandidatesByGuardedPrior(
				a.candidate,
				b.candidate,
				bestCosine,
				bestLexicalScore,
				worstLexicalScore
			) ||
			metadataOrder(a.candidate, b.candidate)
	);
	const result: MemoryCandidate[] = [];
	for (let index = 0; index < Math.min(ranked.length, limit); index++)
		result.push(ranked[index].candidate);
	return result;
}
