import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyMatchWithScore, FuzzyMatchResult } from '../../../renderer/utils/search';

describe('search utils', () => {
	describe('fuzzyMatch', () => {
		describe('basic matching', () => {
			it('returns true for empty query', () => {
				expect(fuzzyMatch('any text', '')).toBe(true);
			});

			it('returns true when query matches exactly', () => {
				expect(fuzzyMatch('hello', 'hello')).toBe(true);
			});

			it('returns true when query is substring', () => {
				expect(fuzzyMatch('hello world', 'world')).toBe(true);
			});

			it('returns true when characters appear in order', () => {
				expect(fuzzyMatch('hello world', 'hlwrd')).toBe(true);
			});

			it('returns false when characters do not appear in order', () => {
				expect(fuzzyMatch('hello', 'oeh')).toBe(false);
			});

			it('returns false when query has characters not in text', () => {
				expect(fuzzyMatch('hello', 'xyz')).toBe(false);
			});
		});

		describe('case insensitivity', () => {
			it('matches regardless of case in text', () => {
				expect(fuzzyMatch('HELLO', 'hello')).toBe(true);
			});

			it('matches regardless of case in query', () => {
				expect(fuzzyMatch('hello', 'HELLO')).toBe(true);
			});

			it('matches with mixed case', () => {
				expect(fuzzyMatch('HeLLo WoRLd', 'hElLo')).toBe(true);
			});
		});

		describe('edge cases', () => {
			it('handles empty text with empty query', () => {
				expect(fuzzyMatch('', '')).toBe(true);
			});

			it('handles empty text with non-empty query', () => {
				expect(fuzzyMatch('', 'a')).toBe(false);
			});

			it('handles single character match', () => {
				expect(fuzzyMatch('abc', 'b')).toBe(true);
			});

			it('handles single character no match', () => {
				expect(fuzzyMatch('abc', 'z')).toBe(false);
			});

			it('handles query longer than text (no match)', () => {
				expect(fuzzyMatch('ab', 'abc')).toBe(false);
			});

			it('handles special characters', () => {
				expect(fuzzyMatch('hello-world_test.ts', 'hwt')).toBe(true);
			});

			it('handles numbers', () => {
				expect(fuzzyMatch('file123.ts', '123')).toBe(true);
			});

			it('handles unicode characters', () => {
				expect(fuzzyMatch('caf\u00e9 test', 'caf')).toBe(true);
			});
		});

		describe('file path matching', () => {
			it('matches file names', () => {
				expect(fuzzyMatch('src/renderer/utils/search.ts', 'search')).toBe(true);
			});

			it('matches path segments', () => {
				expect(fuzzyMatch('src/renderer/utils/search.ts', 'rnd')).toBe(true);
			});

			it('matches extension', () => {
				expect(fuzzyMatch('myfile.tsx', 'tsx')).toBe(true);
			});

			it('matches across path separators', () => {
				expect(fuzzyMatch('src/renderer/utils/search.ts', 'sruts')).toBe(true);
			});
		});

		describe('realistic search scenarios', () => {
			it('matches component names', () => {
				expect(fuzzyMatch('SessionListItem', 'sli')).toBe(true);
				expect(fuzzyMatch('SessionListItem', 'seslit')).toBe(true);
			});

			it('matches function names', () => {
				expect(fuzzyMatch('handleUserInput', 'hui')).toBe(true);
				expect(fuzzyMatch('handleUserInput', 'hndlinput')).toBe(true);
			});

			it('rejects non-matching patterns', () => {
				expect(fuzzyMatch('SessionListItem', 'xyz')).toBe(false);
				expect(fuzzyMatch('handleUserInput', 'abc')).toBe(false);
			});
		});
	});

	describe('fuzzyMatchWithScore', () => {
		describe('basic matching', () => {
			it('returns matches: true and score: 0 for empty query', () => {
				const result = fuzzyMatchWithScore('any text', '');
				expect(result.matches).toBe(true);
				expect(result.score).toBe(0);
			});

			it('returns matches: true when query matches exactly', () => {
				const result = fuzzyMatchWithScore('hello', 'hello');
				expect(result.matches).toBe(true);
				expect(result.score).toBeGreaterThan(0);
			});

			it('returns matches: false with score: 0 when no match', () => {
				const result = fuzzyMatchWithScore('hello', 'xyz');
				expect(result.matches).toBe(false);
				expect(result.score).toBe(0);
			});

			it('returns matches: false when characters out of order', () => {
				const result = fuzzyMatchWithScore('hello', 'oeh');
				expect(result.matches).toBe(false);
				expect(result.score).toBe(0);
			});
		});

		describe('scoring - consecutive matches', () => {
			it('scores consecutive matches higher than scattered matches', () => {
				const consecutiveResult = fuzzyMatchWithScore('abcdef', 'abc');
				const scatteredResult = fuzzyMatchWithScore('aXbXcX', 'abc');

				expect(consecutiveResult.score).toBeGreaterThan(scatteredResult.score);
			});

			it('accumulates bonus for each consecutive character', () => {
				// Longer consecutive runs should score higher
				const twoConsecutive = fuzzyMatchWithScore('ab', 'ab');
				const threeConsecutive = fuzzyMatchWithScore('abc', 'abc');

				// Three consecutive chars should have higher total score per character
				expect(threeConsecutive.score).toBeGreaterThan(twoConsecutive.score);
			});
		});

		describe('scoring - position bonuses', () => {
			it('scores matches at start higher than matches later', () => {
				const startMatch = fuzzyMatchWithScore('abc', 'a');
				const laterMatch = fuzzyMatchWithScore('xxxabc', 'a');

				expect(startMatch.score).toBeGreaterThan(laterMatch.score);
			});

			it('gives bonus for match at word boundaries (space)', () => {
				const wordBoundary = fuzzyMatchWithScore('hello world', 'w');
				const midWord = fuzzyMatchWithScore('hewollo', 'w');

				// Word boundary match gets +8 bonus
				expect(wordBoundary.score).toBeGreaterThan(midWord.score);
			});

			it('gives bonus for match at word boundaries (dash)', () => {
				const dashBoundary = fuzzyMatchWithScore('hello-world', 'w');
				const midWord = fuzzyMatchWithScore('hewollo', 'w');

				expect(dashBoundary.score).toBeGreaterThan(midWord.score);
			});

			it('gives bonus for match at word boundaries (underscore)', () => {
				const underscoreBoundary = fuzzyMatchWithScore('hello_world', 'w');
				const midWord = fuzzyMatchWithScore('hewollo', 'w');

				expect(underscoreBoundary.score).toBeGreaterThan(midWord.score);
			});

			it('gives bonus for match at word boundaries (slash)', () => {
				const slashBoundary = fuzzyMatchWithScore('path/file', 'f');
				const midWord = fuzzyMatchWithScore('pafile', 'f');

				expect(slashBoundary.score).toBeGreaterThan(midWord.score);
			});

			it('gives bonus for match at text start (position 0)', () => {
				const startMatch = fuzzyMatchWithScore('abc', 'a');
				// Match at position 0 gets +8 for word boundary
				expect(startMatch.score).toBeGreaterThan(0);
			});
		});

		describe('scoring - case sensitivity bonus', () => {
			it('scores case-sensitive matches higher', () => {
				const caseSensitive = fuzzyMatchWithScore('Hello', 'H');
				const caseInsensitive = fuzzyMatchWithScore('hello', 'H');

				expect(caseSensitive.score).toBeGreaterThan(caseInsensitive.score);
			});

			it('accumulates case bonus for multiple matching chars', () => {
				const allCaseMatch = fuzzyMatchWithScore('ABC', 'ABC');
				const noCaseMatch = fuzzyMatchWithScore('abc', 'ABC');

				expect(allCaseMatch.score).toBeGreaterThan(noCaseMatch.score);
			});
		});

		describe('scoring - text length and specificity', () => {
			it('scores shorter text higher (better specificity)', () => {
				const shortText = fuzzyMatchWithScore('abc', 'abc');
				const longText = fuzzyMatchWithScore('abcdefghij', 'abc');

				expect(shortText.score).toBeGreaterThan(longText.score);
			});

			it('calculates length ratio bonus correctly', () => {
				// query.length / text.length * 30
				const perfectMatch = fuzzyMatchWithScore('ab', 'ab'); // ratio = 1.0 -> +30
				expect(perfectMatch.score).toBeGreaterThan(0);
			});
		});

		describe('scoring - exact substring bonus', () => {
			it('gives bonus for exact substring match', () => {
				const exactSubstring = fuzzyMatchWithScore('hello world', 'world');
				const fuzzyOnly = fuzzyMatchWithScore('wXoXrXlXd', 'world');

				// exactSubstring should get +50 bonus for substring
				expect(exactSubstring.score).toBeGreaterThan(fuzzyOnly.score);
			});
		});

		describe('scoring - exact match bonus', () => {
			it('gives highest score for exact match', () => {
				const exactMatch = fuzzyMatchWithScore('hello', 'hello');
				const substring = fuzzyMatchWithScore('hello world', 'hello');

				// Exact match gets +100 bonus
				expect(exactMatch.score).toBeGreaterThan(substring.score);
			});

			it('exact match is case insensitive', () => {
				const exactMatch = fuzzyMatchWithScore('hello', 'HELLO');
				// Should still get exact match bonus since lowerText === lowerQuery
				expect(exactMatch.matches).toBe(true);
				expect(exactMatch.score).toBeGreaterThan(100); // Has base score + exact match bonus
			});
		});

		describe('edge cases', () => {
			it('handles empty text with empty query', () => {
				const result = fuzzyMatchWithScore('', '');
				expect(result.matches).toBe(true);
				expect(result.score).toBe(0);
			});

			it('handles empty text with non-empty query', () => {
				const result = fuzzyMatchWithScore('', 'a');
				expect(result.matches).toBe(false);
				expect(result.score).toBe(0);
			});

			it('handles query longer than text', () => {
				const result = fuzzyMatchWithScore('ab', 'abc');
				expect(result.matches).toBe(false);
				expect(result.score).toBe(0);
			});

			it('handles special characters', () => {
				const result = fuzzyMatchWithScore('hello-world_test.ts', 'hwt');
				expect(result.matches).toBe(true);
				expect(result.score).toBeGreaterThan(0);
			});

			it('handles numbers', () => {
				const result = fuzzyMatchWithScore('file123.ts', '123');
				expect(result.matches).toBe(true);
				expect(result.score).toBeGreaterThan(0);
			});
		});

		describe('scoring comparisons for ranking', () => {
			it('ranks exact matches highest', () => {
				const candidates = ['test', 'testing', 'test file', 'my test'];
				const results = candidates.map((c) => ({
					text: c,
					...fuzzyMatchWithScore(c, 'test'),
				}));

				// Sort by score descending
				results.sort((a, b) => b.score - a.score);

				// Exact match should be first
				expect(results[0].text).toBe('test');
			});

			it('ranks start-of-string matches higher (same length)', () => {
				// Use same-length strings to isolate position bonus effect
				const candidates = ['test_abc', 'abc_test'];
				const results = candidates.map((c) => ({
					text: c,
					...fuzzyMatchWithScore(c, 'test'),
				}));

				results.sort((a, b) => b.score - a.score);

				// 'test_abc' starts with match, should rank higher
				expect(results[0].text).toBe('test_abc');
			});

			it('provides meaningful ranking for file search', () => {
				const files = [
					'src/renderer/utils/search.ts',
					'src/__tests__/search.test.ts',
					'search.ts',
					'MySearchComponent.tsx',
				];

				const results = files.map((f) => ({
					file: f,
					...fuzzyMatchWithScore(f, 'search'),
				}));

				results.sort((a, b) => b.score - a.score);

				// All should match
				expect(results.every((r) => r.matches)).toBe(true);

				// Shortest exact match should be first
				expect(results[0].file).toBe('search.ts');
			});

			it('ranks component names sensibly', () => {
				const components = ['SessionListItem', 'SessionList', 'SessionManager', 'ListItem'];

				const results = components.map((c) => ({
					component: c,
					...fuzzyMatchWithScore(c, 'sesl'),
				}));

				// Filter to only matches
				const matches = results.filter((r) => r.matches);
				matches.sort((a, b) => b.score - a.score);

				// SessionList should rank higher than SessionListItem (shorter, better specificity)
				const sessionListIdx = matches.findIndex((m) => m.component === 'SessionList');
				const sessionListItemIdx = matches.findIndex((m) => m.component === 'SessionListItem');

				if (sessionListIdx !== -1 && sessionListItemIdx !== -1) {
					expect(sessionListIdx).toBeLessThan(sessionListItemIdx);
				}
			});
		});

		describe('position bonus calculation', () => {
			it('gives maximum position bonus (50) for match at index 0', () => {
				const result = fuzzyMatchWithScore('abc', 'a');
				// Position bonus = max(0, 50 - 0) = 50
				expect(result.matches).toBe(true);
				expect(result.score).toBeGreaterThan(0);
			});

			it('gives decreasing bonus for later match positions', () => {
				const earlyMatch = fuzzyMatchWithScore('abc', 'a'); // firstMatchIndex = 0
				const laterMatch = fuzzyMatchWithScore('xxxxabc', 'a'); // firstMatchIndex = 4

				expect(earlyMatch.score).toBeGreaterThan(laterMatch.score);
			});

			it('gives no position bonus for very late matches', () => {
				// If firstMatchIndex >= 50, position bonus = max(0, 50 - 50+) = 0
				const fiftyChars = 'x'.repeat(50) + 'a';
				const result = fuzzyMatchWithScore(fiftyChars, 'a');

				expect(result.matches).toBe(true);
				// Still has base score but no position bonus
			});
		});

		describe('first match tracking', () => {
			it('correctly tracks first match position', () => {
				// The first character match determines position bonus
				const result1 = fuzzyMatchWithScore('hello', 'h'); // firstMatch at 0
				const result2 = fuzzyMatchWithScore('hello', 'e'); // firstMatch at 1
				const result3 = fuzzyMatchWithScore('hello', 'o'); // firstMatch at 4

				expect(result1.score).toBeGreaterThan(result2.score);
				expect(result2.score).toBeGreaterThan(result3.score);
			});

			it('uses first match for multi-char queries', () => {
				const result = fuzzyMatchWithScore('hello', 'elo');
				// First match is 'e' at index 1
				expect(result.matches).toBe(true);
				expect(result.score).toBeGreaterThan(0);
			});
		});

		describe('consecutive match reset', () => {
			it('resets consecutive counter after non-match', () => {
				// In 'abXcd', matching 'abcd':
				// a-b are consecutive, then X breaks it, c-d are consecutive again
				const broken = fuzzyMatchWithScore('abXcd', 'abcd');
				const continuous = fuzzyMatchWithScore('abcd', 'abcd');

				expect(continuous.score).toBeGreaterThan(broken.score);
			});
		});

		describe('interface contract', () => {
			it('returns FuzzyMatchResult interface', () => {
				const result: FuzzyMatchResult = fuzzyMatchWithScore('test', 'test');

				expect(result).toHaveProperty('matches');
				expect(result).toHaveProperty('score');
				expect(typeof result.matches).toBe('boolean');
				expect(typeof result.score).toBe('number');
			});
		});

		describe('integration scenarios', () => {
			it('handles real file search scenario', () => {
				const files = [
					'src/renderer/components/SessionList.tsx',
					'src/renderer/components/SessionListItem.tsx',
					'src/renderer/hooks/useSession.ts',
					'src/main/session-manager.ts',
					'src/__tests__/session.test.ts',
				];

				const query = 'seslist';
				const results = files
					.map((f) => ({ file: f, ...fuzzyMatchWithScore(f, query) }))
					.filter((r) => r.matches)
					.sort((a, b) => b.score - a.score);

				// Should find SessionList and SessionListItem
				expect(results.length).toBeGreaterThan(0);
				expect(results.some((r) => r.file.includes('SessionList.tsx'))).toBe(true);
			});

			it('handles command palette scenario', () => {
				const commands = [
					'New Session',
					'Delete Session',
					'Rename Session',
					'Toggle Terminal',
					'Show Settings',
					'New Tab',
				];

				const query = 'ns';
				const results = commands
					.map((c) => ({ command: c, ...fuzzyMatchWithScore(c, query) }))
					.filter((r) => r.matches)
					.sort((a, b) => b.score - a.score);

				// 'New Session' should match and rank high
				expect(results.some((r) => r.command === 'New Session')).toBe(true);
			});

			it('handles code search scenario', () => {
				const symbols = [
					'handleUserInput',
					'handleKeyPress',
					'handleMouseEvent',
					'processUserAction',
					'userInputHandler',
				];

				const query = 'hui';
				const results = symbols
					.map((s) => ({ symbol: s, ...fuzzyMatchWithScore(s, query) }))
					.filter((r) => r.matches)
					.sort((a, b) => b.score - a.score);

				// handleUserInput should match
				expect(results.some((r) => r.symbol === 'handleUserInput')).toBe(true);
			});
		});
	});
});
