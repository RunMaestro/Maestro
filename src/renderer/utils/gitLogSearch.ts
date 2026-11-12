/**
 * The Git Log viewer's search predicate, shared by its two views.
 *
 * The list and the graph are built from different `git log` invocations (the
 * list is the current branch, the graph is `--all`), so the one thing that must
 * NOT differ between them is what counts as a hit. A query that hides a commit
 * from the list but leaves it lit in the graph reads as the filter being
 * unreliable, so both views ask this module and nothing else.
 *
 * Matching is SUBSTRING, not fuzzy. A commit hash is the motivating case: a
 * fuzzy matcher scores `a1b2c3d` against nearly every hash in a repository, and
 * the one query where the user knows exactly what they are looking for is the
 * one that would return the whole log.
 *
 * Terms are ANDed. `fix usage` has to find `fix(usage): ...`, which a single
 * literal substring never does, and ANDing whitespace-separated terms is the
 * behaviour every other filter in the app already has.
 */

/** The fields a query is matched against. Both views project onto this shape. */
export interface GitLogSearchable {
	hash: string;
	shortHash?: string;
	subject: string;
	author: string;
	refs?: string[];
	date?: string;
}

/**
 * Split a raw query box value into the terms a commit must match ALL of.
 *
 * Returns an empty array for a blank query, which every caller reads as "no
 * filter" - so an all-whitespace query cannot accidentally hide the whole log.
 */
export function gitLogSearchTerms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether one commit matches every term.
 *
 * `date` is included because the log prints one and a user who can see a date
 * beside a commit will type part of it. It is matched as the raw ISO string the
 * git log carries, so `2026-09` narrows to a month.
 */
export function matchesGitLogTerms(commit: GitLogSearchable, terms: string[]): boolean {
	if (terms.length === 0) return true;
	const haystack = [
		commit.hash,
		commit.shortHash ?? '',
		commit.subject,
		commit.author,
		commit.date ?? '',
		...(commit.refs ?? []),
	]
		// Newline-joined, never concatenated: gluing the fields together would let
		// a term straddle two of them and match text that is nowhere on screen.
		.join('\n')
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}
