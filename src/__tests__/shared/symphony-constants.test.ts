/**
 * Tests for shared/symphony-constants.ts
 * Validates Symphony constants, configuration values, and regex patterns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	SYMPHONY_REGISTRY_URL,
	GITHUB_API_BASE,
	SYMPHONY_ISSUE_LABEL,
	SYMPHONY_BLOCKING_LABEL,
	REGISTRY_CACHE_TTL_MS,
	ISSUES_CACHE_TTL_MS,
	STARS_CACHE_TTL_MS,
	BRANCH_TEMPLATE,
	SYMPHONY_CATEGORIES,
	DOCUMENT_PATH_PATTERNS,
	DEFAULT_CONTRIBUTOR_STATS,
} from '../../shared/symphony-constants';

describe('shared/symphony-constants', () => {
	// ==========================================================================
	// URL Constants Tests
	// ==========================================================================
	describe('SYMPHONY_REGISTRY_URL', () => {
		it('should be a valid GitHub raw URL', () => {
			expect(SYMPHONY_REGISTRY_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
		});

		it('should point to the main branch', () => {
			expect(SYMPHONY_REGISTRY_URL).toContain('/main/');
		});

		it('should reference a JSON file', () => {
			expect(SYMPHONY_REGISTRY_URL).toMatch(/\.json$/);
		});
	});

	describe('GITHUB_API_BASE', () => {
		it('should be the correct GitHub API URL', () => {
			expect(GITHUB_API_BASE).toBe('https://api.github.com');
		});
	});

	// ==========================================================================
	// Label and Cache Constants Tests
	// ==========================================================================
	describe('SYMPHONY_ISSUE_LABEL', () => {
		it('should be "runmaestro.ai"', () => {
			expect(SYMPHONY_ISSUE_LABEL).toBe('runmaestro.ai');
		});
	});

	describe('SYMPHONY_BLOCKING_LABEL', () => {
		it('should be "blocking"', () => {
			expect(SYMPHONY_BLOCKING_LABEL).toBe('blocking');
		});
	});

	describe('REGISTRY_CACHE_TTL_MS', () => {
		it('should be 2 hours in milliseconds', () => {
			const twoHoursMs = 2 * 60 * 60 * 1000;
			expect(REGISTRY_CACHE_TTL_MS).toBe(twoHoursMs);
		});
	});

	describe('ISSUES_CACHE_TTL_MS', () => {
		it('should be 5 minutes in milliseconds', () => {
			const fiveMinutesMs = 5 * 60 * 1000;
			expect(ISSUES_CACHE_TTL_MS).toBe(fiveMinutesMs);
		});
	});

	describe('STARS_CACHE_TTL_MS', () => {
		it('should be 24 hours in milliseconds', () => {
			const twentyFourHoursMs = 24 * 60 * 60 * 1000;
			expect(STARS_CACHE_TTL_MS).toBe(twentyFourHoursMs);
		});
	});

	// ==========================================================================
	// Branch Template Tests
	// ==========================================================================
	describe('BRANCH_TEMPLATE', () => {
		it('should contain {issue} placeholder', () => {
			expect(BRANCH_TEMPLATE).toContain('{issue}');
		});

		it('should contain {timestamp} placeholder', () => {
			expect(BRANCH_TEMPLATE).toContain('{timestamp}');
		});

		it('should start with "symphony/"', () => {
			expect(BRANCH_TEMPLATE).toMatch(/^symphony\//);
		});
	});

	// ==========================================================================
	// Categories Tests
	// ==========================================================================
	describe('SYMPHONY_CATEGORIES', () => {
		it('should include core categories used by existing registry entries', () => {
			const coreCategories = ['ai-ml', 'developer-tools', 'productivity', 'other'];
			for (const category of coreCategories) {
				expect(SYMPHONY_CATEGORIES).toHaveProperty(category);
			}
		});

		it('should have at least 10 categories for broad coverage', () => {
			expect(Object.keys(SYMPHONY_CATEGORIES).length).toBeGreaterThanOrEqual(10);
		});

		it('should have entries with label and emoji properties', () => {
			for (const [key, value] of Object.entries(SYMPHONY_CATEGORIES)) {
				expect(value).toHaveProperty('label');
				expect(value).toHaveProperty('emoji');
				expect(typeof value.label).toBe('string');
				expect(typeof value.emoji).toBe('string');
				expect(value.label.length).toBeGreaterThan(0);
				expect(value.emoji.length).toBeGreaterThan(0);
			}
		});

		it('should have unique labels for each category', () => {
			const labels = Object.values(SYMPHONY_CATEGORIES).map((v) => v.label);
			const uniqueLabels = new Set(labels);
			expect(uniqueLabels.size).toBe(labels.length);
		});
	});

	// ==========================================================================
	// Default Contributor Stats Tests
	// ==========================================================================
	describe('DEFAULT_CONTRIBUTOR_STATS', () => {
		it('should have all required count fields initialized to zero', () => {
			expect(DEFAULT_CONTRIBUTOR_STATS.totalContributions).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.totalMerged).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.totalIssuesResolved).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.totalDocumentsProcessed).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.totalTasksCompleted).toBe(0);
		});

		it('should have all required resource fields initialized to zero', () => {
			expect(DEFAULT_CONTRIBUTOR_STATS.totalTokensUsed).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.totalTimeSpent).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.estimatedCostDonated).toBe(0);
		});

		it('should have repositoriesContributed as empty array', () => {
			expect(DEFAULT_CONTRIBUTOR_STATS.repositoriesContributed).toEqual([]);
			expect(Array.isArray(DEFAULT_CONTRIBUTOR_STATS.repositoriesContributed)).toBe(true);
		});

		it('should have streak fields initialized to zero', () => {
			expect(DEFAULT_CONTRIBUTOR_STATS.currentStreak).toBe(0);
			expect(DEFAULT_CONTRIBUTOR_STATS.longestStreak).toBe(0);
		});

		it('should have uniqueMaintainersHelped initialized to zero', () => {
			expect(DEFAULT_CONTRIBUTOR_STATS.uniqueMaintainersHelped).toBe(0);
		});
	});

	// ==========================================================================
	// Document Path Patterns Tests
	// ==========================================================================
	describe('DOCUMENT_PATH_PATTERNS', () => {
		it('should have 3 patterns', () => {
			expect(DOCUMENT_PATH_PATTERNS).toHaveLength(3);
		});

		describe('Pattern 0: Bullet list items with .md files', () => {
			const pattern = DOCUMENT_PATH_PATTERNS[0];

			beforeEach(() => {
				// Reset lastIndex for global regex
				pattern.lastIndex = 0;
			});

			it('should match bullet list items with .md files', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('- path/to/doc.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('path/to/doc.md');
			});

			it('should match bullet items with backtick-wrapped paths', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('- `path/to/doc.md`');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('path/to/doc.md');
			});

			it('should match asterisk bullet items', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('* docs/task.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('docs/task.md');
			});

			it('should match with leading whitespace (up to 20 chars)', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('    - docs/task.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('docs/task.md');
			});
		});

		describe('Pattern 1: Numbered list items', () => {
			const pattern = DOCUMENT_PATH_PATTERNS[1];

			beforeEach(() => {
				pattern.lastIndex = 0;
			});

			it('should match numbered list items', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('1. path/to/doc.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('path/to/doc.md');
			});

			it('should match numbered items with backticks', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('2. `docs/task.md`');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('docs/task.md');
			});

			it('should match multi-digit numbered items', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('10. docs/file.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('docs/file.md');
			});
		});

		describe('Pattern 2: Bare .md paths on their own line', () => {
			const pattern = DOCUMENT_PATH_PATTERNS[2];

			beforeEach(() => {
				pattern.lastIndex = 0;
			});

			it('should match bare .md paths on their own line', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('path/to/doc.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('path/to/doc.md');
			});

			it('should match paths with leading whitespace', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('  docs/task.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('docs/task.md');
			});

			it('should match paths with hyphens and underscores', () => {
				pattern.lastIndex = 0;
				const match = pattern.exec('my-docs/some_file.md');
				expect(match).not.toBeNull();
				expect(match?.[1]).toBe('my-docs/some_file.md');
			});
		});

		describe('ReDoS prevention', () => {
			it('should have bounded repetition to prevent ReDoS', () => {
				// All patterns should have explicit bounds on repetition
				for (const pattern of DOCUMENT_PATH_PATTERNS) {
					const patternStr = pattern.source;
					// Check for bounded whitespace: {0,20} or similar
					expect(patternStr).toMatch(/\{0,\d+\}/);
				}
			});

			it('should reject excessively long leading whitespace (>20 chars)', () => {
				const longWhitespace = ' '.repeat(25);

				for (const pattern of DOCUMENT_PATH_PATTERNS) {
					pattern.lastIndex = 0;
					const match = pattern.exec(`${longWhitespace}- doc.md`);
					// Should not match at the start with excessive whitespace
					expect(match).toBeNull();
				}
			});

			it('should complete quickly even with adversarial input', () => {
				const adversarialInput = ' '.repeat(20) + 'a'.repeat(100) + '.md';
				const startTime = performance.now();

				for (const pattern of DOCUMENT_PATH_PATTERNS) {
					pattern.lastIndex = 0;
					pattern.exec(adversarialInput);
				}

				const elapsed = performance.now() - startTime;
				// Should complete in under 100ms even for adversarial input
				expect(elapsed).toBeLessThan(100);
			});
		});
	});
});
