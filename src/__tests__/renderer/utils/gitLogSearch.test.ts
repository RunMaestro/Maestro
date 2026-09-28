import { describe, it, expect } from 'vitest';
import { gitLogSearchTerms, matchesGitLogTerms } from '../../../renderer/utils/gitLogSearch';

const commit = {
	hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
	shortHash: 'a1b2c3d',
	subject: 'fix(usage): keep a capped plan account on the dashboard',
	author: 'Pedram Amini',
	date: '2026-09-17T02:52:13-05:00',
	refs: ['HEAD -> rc', 'origin/rc'],
};

describe('gitLogSearchTerms', () => {
	it('returns no terms for a blank or whitespace-only query', () => {
		expect(gitLogSearchTerms('')).toEqual([]);
		expect(gitLogSearchTerms('   \t ')).toEqual([]);
	});

	it('splits on whitespace and lowercases', () => {
		expect(gitLogSearchTerms('  Fix   Usage ')).toEqual(['fix', 'usage']);
	});
});

describe('matchesGitLogTerms', () => {
	it('matches everything when there is no query', () => {
		expect(matchesGitLogTerms(commit, [])).toBe(true);
	});

	it('matches a short-hash prefix, which is what a user types from memory', () => {
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('a1b2'))).toBe(true);
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('A1B2C3D'))).toBe(true);
	});

	it('matches a full-hash tail that the short hash alone does not contain', () => {
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('12345678'))).toBe(true);
	});

	it('matches the subject, the author, a ref and the date', () => {
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('dashboard'))).toBe(true);
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('pedram'))).toBe(true);
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('origin/rc'))).toBe(true);
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('2026-09'))).toBe(true);
	});

	// The reason terms are ANDed rather than matched as one literal: the words a
	// user remembers are rarely adjacent in the subject line they came from.
	it('ANDs the terms, so separated words still find the commit', () => {
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('fix usage'))).toBe(true);
		expect(matchesGitLogTerms(commit, gitLogSearchTerms('fix nothing'))).toBe(false);
	});

	it('does not match a term straddling two fields', () => {
		// 'rc' ends the last ref and 'Pedram' starts the author; concatenating the
		// haystack would invent 'rcpedram' as a hit.
		expect(matchesGitLogTerms(commit, ['a1b2c3dfix'])).toBe(false);
	});

	it('tolerates a commit with no short hash, refs or date', () => {
		expect(
			matchesGitLogTerms({ hash: 'deadbeef', subject: 'x', author: 'y' }, gitLogSearchTerms('dead'))
		).toBe(true);
	});
});
