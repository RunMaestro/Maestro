import type { ContextualMemory } from '../../shared/pianola/memory';

/** Ranking metadata only: no evidence payloads or relationship hydration. */
export interface MemoryCandidate {
	memory: Pick<
		ContextualMemory,
		| 'id'
		| 'userId'
		| 'projectId'
		| 'kind'
		| 'text'
		| 'support'
		| 'status'
		| 'validFrom'
		| 'validTo'
		| 'learnedAt'
		| 'pinned'
		| 'supersedes'
	> &
		Partial<Pick<ContextualMemory, 'rationale' | 'alternatives'>>;
	lexicalRank?: number;
	/** The lexical channel's BM25 score for this row; more negative is a better match. */
	lexicalScore?: number;
	vectorRank?: number;
	/** Native sqlite-vec L2 distance, retained for diagnostics. */
	vectorDistance?: number;
	/** L2 squared / 2 for the bank's normalized embedding space. */
	cosineDistance?: number;
	/** Hosted cross-encoder score; present only for an explicitly reranked recall. */
	rerankScore?: number;
}
