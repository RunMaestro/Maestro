// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/sentryFilters.test.ts
// Source: src/__tests__/shared/symphony-constants.test.ts
// Source: src/__tests__/shared/providerProfiles.test.ts
// Source: src/__tests__/shared/statsGroupRollup.test.ts
// Source: src/__tests__/shared/snooze.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldDropSentryEvent } from '../../shared/sentryFilters';
import {
	SYMPHONY_REGISTRY_URL,
	GITHUB_API_BASE,
	SYMPHONY_ISSUE_LABEL,
	SYMPHONY_BLOCKING_LABEL,
	REGISTRY_CACHE_TTL_MS,
	ISSUES_CACHE_TTL_MS,
	STARS_CACHE_TTL_MS,
	ISSUE_COUNTS_CACHE_TTL_MS,
	BRANCH_TEMPLATE,
	SYMPHONY_CATEGORIES,
	DOCUMENT_PATH_PATTERNS,
	DEFAULT_CONTRIBUTOR_STATS,
} from '../../shared/symphony-constants';
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	isAccountDirName,
	makeAccountKeyHelpers,
	parseProviderProfileKey,
	providerProfileKey,
	providerProfileLabel,
	providerProfileShortLabel,
	resolveAgentAccountKey,
	resolveAgentBillingCredential,
	resolveAgentProfile,
} from '../../shared/providerProfiles';
import {
	rollUpGroupStats,
	rollUpGroup,
	groupSessions,
	totalTokens,
	UNGROUPED_ID,
	UNGROUPED_NAME,
	type GroupLike,
	type GroupMemberSession,
} from '../../shared/statsGroupRollup';
import type { StatsAggregation } from '../../shared/stats-types';
import {
	parseSnoozeInput,
	formatSnoozeCountdown,
	formatSnoozeTarget,
	SNOOZE_PRESETS,
	SNOOZE_DEFAULT_HOUR,
	MIN_SNOOZE_MS,
} from '../../shared/snooze';
// Source: src/__tests__/shared/sentryFilters.test.ts
describe('', () => {
	function exceptionEvent(type: string, value: string) {
		return { exception: { values: [{ type, value }] } };
	}
	describe('shouldDropSentryEvent', () => {
		it('drops expected host reconnect events from direct SDK callers', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						'Not submitted: restoring authoritative host state. Your current work is retained.'
					)
				)
			).toBe(true);
			expect(
				shouldDropSentryEvent({
					message: 'Not submitted: reconnecting to the host. Your current work is retained.',
				})
			).toBe(true);
		});
		it('retains uncertain submissions and unexpected host failures', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						'Submission uncertainty: connection lost before acknowledgement of process:spawn'
					)
				)
			).toBe(false);
			expect(
				shouldDropSentryEvent(exceptionEvent('Error', 'Bridge request timed out: process:spawn'))
			).toBe(false);
			expect(shouldDropSentryEvent(exceptionEvent('Error', 'Invalid host snapshot payload'))).toBe(
				false
			);
		});
		describe('OS / filesystem environment', () => {
			it('drops ENOSPC out-of-disk errors', () => {
				expect(
					shouldDropSentryEvent(exceptionEvent('Error', 'ENOSPC: no space left on device, write'))
				).toBe(true);
			});
			it('drops SQLITE_FULL, the SQLite wording for the same full disk (MAESTRO-ZD)', () => {
				expect(
					shouldDropSentryEvent(exceptionEvent('SqliteError', 'database or disk is full'))
				).toBe(true);
			});
			it('still reports SQLite failures that can indicate a real bug', () => {
				expect(
					shouldDropSentryEvent(exceptionEvent('SqliteError', 'database disk image is malformed'))
				).toBe(false);
				expect(shouldDropSentryEvent(exceptionEvent('SqliteError', 'database is locked'))).toBe(
					false
				);
				expect(
					shouldDropSentryEvent(exceptionEvent('SqliteError', 'no such table: query_events'))
				).toBe(false);
			});
			it('drops EPIPE broken-pipe errors', () => {
				expect(shouldDropSentryEvent(exceptionEvent('Error', 'EPIPE: broken pipe, write'))).toBe(
					true
				);
			});
			// The libuv `EPIPE: broken pipe` spelling above is not what Node emits for a
			// stream/socket write to a dead pipe - that surfaces as a bare `write EPIPE`,
			// which slipped past the filter and was the single noisiest issue in the field.
			it('drops bare `write EPIPE` stream errors (Node stream spelling)', () => {
				expect(shouldDropSentryEvent(exceptionEvent('Error', 'write EPIPE'))).toBe(true);
			});
			it('drops bare `read EPIPE` stream errors', () => {
				expect(shouldDropSentryEvent(exceptionEvent('Error', 'read EPIPE'))).toBe(true);
			});
			it('drops Windows rename races (EPERM rename)', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"EPERM: operation not permitted, rename 'C:\\foo.tmp' -> 'C:\\foo'"
						)
					)
				).toBe(true);
			});
			it('drops EBUSY/EPERM lstat on Windows system files', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('Error', "EBUSY: resource busy or locked, lstat 'C:\\pagefile.sys'")
					)
				).toBe(true);
			});
			it('does NOT drop EBUSY lstat on a user file', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"EBUSY: resource busy or locked, lstat 'C:\\Users\\me\\report.pdf'"
						)
					)
				).toBe(false);
			});
			it('drops ETIMEDOUT scandir on network filesystems', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('Error', "ETIMEDOUT: connection timed out, scandir '/mnt/nfs/x'")
					)
				).toBe(true);
			});
			it('drops EISDIR watch errors', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('Error', "EISDIR: illegal operation on a directory, watch '/foo'")
					)
				).toBe(true);
			});
		});
		describe('IPC method noise (user-typed paths that do not exist)', () => {
			it('drops ENOENT bubbling up through fs:stat', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'fs:stat': Error: ENOENT: no such file or directory, stat '/typo'"
						)
					)
				).toBe(true);
			});
			it('drops Path-not-found through shell:trashItem', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'shell:trashItem': Error: Path does not exist: /typo"
						)
					)
				).toBe(true);
			});
			// MAESTRO-9V: Electron's catch-all when the OS refuses to trash a path
			// (file open elsewhere, no recycle bin on the volume, permissions). The
			// delete is user-initiated and the caller already toasts this exact
			// message, so the crash report on top of it is noise.
			it('drops the generic trash failure through shell:trashItem', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'shell:trashItem': Error: Failed to perform delete operation"
						)
					)
				).toBe(true);
			});
			// MAESTRO-15T: the Linux wording of the same refusal.
			it('drops the Linux trash failure through shell:trashItem', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'shell:trashItem': Error: Failed to move item to trash"
						)
					)
				).toBe(true);
			});
			// MAESTRO-16F/16G/176: agent prose linked as a path is too long to stat.
			it('drops ENAMETOOLONG through fs:stat and fs:readFile', () => {
				for (const [method, op] of [
					['fs:stat', 'Failed to get file stats: Error: ENAMETOOLONG: name too long, stat'],
					['fs:readFile', 'Failed to read file: Error: ENAMETOOLONG: name too long, open'],
				]) {
					expect(
						shouldDropSentryEvent(
							exceptionEvent(
								'Error',
								`Error invoking remote method '${method}': Error: ${op} '/consegna verificata; nessun output trovato...'`
							)
						)
					).toBe(true);
				}
			});
			it('keeps ENAMETOOLONG from a spawn, which is our own argv', () => {
				expect(shouldDropSentryEvent(exceptionEvent('Error', 'spawn ENAMETOOLONG'))).toBe(false);
			});
			it('keeps a generic delete failure that did NOT come from shell:trashItem', () => {
				// The rule is scoped to the one IPC channel we know shows a toast -
				// the same words arriving from anywhere else are still signal.
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'fs:deleteFile': Error: Failed to perform delete operation"
						)
					)
				).toBe(false);
			});
			it('keeps unrelated shell:trashItem failures', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'shell:trashItem': Error: EBUSY: resource busy or locked"
						)
					)
				).toBe(false);
			});
			it('drops EACCES on the sessions file bubbling up through sessions:setMany', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'sessions:setMany': Error: EACCES: permission denied, open '/Users/x/Library/Application Support/maestro/maestro-sessions.json'"
						)
					)
				).toBe(true);
			});
			it('does NOT drop a generic IPC failure that is not a known noise pattern', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'sessions:create': TypeError: Cannot read properties of undefined (reading 'name')"
						)
					)
				).toBe(false);
			});
			// A write failure that is *not* an environment/permissions problem still needs to
			// reach us - the EACCES carve-out above must not swallow real persistence bugs.
			it('does NOT drop a non-environment failure on the same sessions:setMany method', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							"Error invoking remote method 'sessions:setMany': TypeError: sessions.map is not a function"
						)
					)
				).toBe(false);
			});
		});
		describe('Native Chromium / Electron crashes', () => {
			it('drops partition_alloc:: crashes', () => {
				expect(shouldDropSentryEvent(exceptionEvent('partition_alloc::OomDeathTask', ''))).toBe(
					true
				);
			});
			it('drops blink:: crashes', () => {
				expect(shouldDropSentryEvent(exceptionEvent('blink::LocalFrameView::Layout', ''))).toBe(
					true
				);
			});
			it('drops rx::ContextGL:: crashes', () => {
				expect(shouldDropSentryEvent(exceptionEvent('rx::ContextGL::initialize', ''))).toBe(true);
			});
			it('drops unknown empty-value crashes', () => {
				expect(shouldDropSentryEvent(exceptionEvent('<unknown>', ''))).toBe(true);
			});
		});
		describe('External JS injection (antivirus / extensions corrupting the bundle)', () => {
			it('drops splash-stage ReferenceError for non-shipped symbol `i`', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('Error', 'Renderer error: [Splash] ReferenceError: i is not defined')
					)
				).toBe(true);
			});
			it('drops CSP-block errors from injected proxies', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('Error', 'Page failed to load: ERR_BLOCKED_BY_CSP at https://example')
					)
				).toBe(true);
			});
		});
		describe('Network / shell environment', () => {
			it('drops marketplace fetch failures when the user is offline', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'MarketplaceFetchError',
							'MarketplaceFetchError: Network error fetching index: fetch failed'
						)
					)
				).toBe(true);
			});
			// Regression (MAESTRO-MR): MarketplaceFetchError carries the original failure
			// as its `cause`, so Sentry's LinkedErrors integration ships TWO exception
			// values ordered root-cause-first. The classifier used to read values[0]
			// only, saw the bare `TypeError: fetch failed`, and let the event through -
			// the rule above looked correct but never fired in the field.
			it('drops marketplace fetch failures when Sentry expanded the cause chain', () => {
				expect(
					shouldDropSentryEvent({
						exception: {
							values: [
								{ type: 'TypeError', value: 'fetch failed' },
								{
									type: 'MarketplaceFetchError',
									value: 'Network error fetching document: fetch failed',
								},
							],
						},
					})
				).toBe(true);
			});
			// Regression (MAESTRO-TY): GitHub raw rate-limits playbook imports.
			it('drops marketplace fetches rejected by GitHub rate limiting or a 5xx', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'MarketplaceFetchError',
							'Failed to fetch document: 429 Too Many Requests'
						)
					)
				).toBe(true);
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'MarketplaceFetchError',
							'Failed to fetch asset: 503 Service Unavailable'
						)
					)
				).toBe(true);
			});
			it('does NOT drop a marketplace document that is genuinely missing', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('MarketplaceFetchError', 'Document not found: setup')
					)
				).toBe(false);
			});
			it('drops GitHub CLI network failures when the user is offline', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent(
							'Error',
							'Command failed: gh pr list\nerror connecting to api.github.com\ncheck your internet connection'
						)
					)
				).toBe(true);
			});
			it('drops shell PATH probe timeouts', () => {
				expect(shouldDropSentryEvent(exceptionEvent('Error', 'Timed out reading shell PATH'))).toBe(
					true
				);
			});
		});
		describe('legitimate errors', () => {
			it('does NOT drop a normal application exception', () => {
				expect(
					shouldDropSentryEvent(
						exceptionEvent('TypeError', "Cannot read properties of undefined (reading 'sessions')")
					)
				).toBe(false);
			});
			it('does NOT drop an event with no exception at all', () => {
				expect(shouldDropSentryEvent({})).toBe(false);
			});
			it('does NOT drop a custom domain error from our code', () => {
				expect(
					shouldDropSentryEvent(exceptionEvent('AgentSpawnError', 'Failed to spawn claude-code'))
				).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/shared/symphony-constants.test.ts
describe('', () => {
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
		describe('ISSUE_COUNTS_CACHE_TTL_MS', () => {
			it('should be 30 minutes in milliseconds', () => {
				const thirtyMinutesMs = 30 * 60 * 1000;
				expect(ISSUE_COUNTS_CACHE_TTL_MS).toBe(thirtyMinutesMs);
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
});
// Source: src/__tests__/shared/providerProfiles.test.ts
describe('', () => {
	const HOME = '/Users/me';
	describe('resolveAgentAccountKey', () => {
		it('uses the provider env var when the agent sets one', () => {
			expect(
				resolveAgentAccountKey(
					'claude-code',
					{ CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash' },
					HOME
				)
			).toBe('/Users/me/.claude-smash');
			expect(resolveAgentAccountKey('codex', { CODEX_HOME: '/Users/me/.codex-work' }, HOME)).toBe(
				'/Users/me/.codex-work'
			);
		});
		it('normalizes trailing slashes so two spellings collapse to one account', () => {
			expect(
				resolveAgentAccountKey(
					'claude-code',
					{ CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash//' },
					HOME
				)
			).toBe('/Users/me/.claude-smash');
		});
		it('falls back to the implicit default account dir when the env var is unset or empty', () => {
			expect(resolveAgentAccountKey('claude-code', {}, HOME)).toBe('/Users/me/.claude');
			expect(resolveAgentAccountKey('claude-code', { CLAUDE_CONFIG_DIR: '' }, HOME)).toBe(
				'/Users/me/.claude'
			);
			expect(resolveAgentAccountKey('codex', undefined, HOME)).toBe('/Users/me/.codex');
		});
		it('returns null when $HOME has not resolved and the agent named no dir', () => {
			// Guessing a default here would file the agent under an account it may
			// not belong to; absent is the honest answer until $HOME arrives.
			expect(resolveAgentAccountKey('claude-code', {}, undefined)).toBeNull();
		});
		it('returns null for a provider with no account concept, even with $HOME', () => {
			// Deliberate omissions, re-verified 2026-09-14: OpenCode's data dir follows
			// the OS-wide XDG_DATA_HOME rather than an OpenCode account selector, and
			// Factory Droid ships no config-dir override at all.
			expect(getProviderProfileConfig('opencode')).toBeUndefined();
			expect(getProviderProfileConfig('factory-droid')).toBeUndefined();
			expect(resolveAgentAccountKey('opencode', {}, HOME)).toBeNull();
			expect(resolveAgentAccountKey('factory-droid', {}, HOME)).toBeNull();
		});
		it('splits Copilot accounts on COPILOT_HOME', () => {
			// COPILOT_HOME, not COPILOT_CONFIG_DIR: GitHub's CLI docs are explicit
			// that COPILOT_HOME replaces the whole ~/.copilot path, and no release
			// has ever read COPILOT_CONFIG_DIR.
			expect(getProviderProfileConfig('copilot-cli')).toEqual({
				envVar: 'COPILOT_HOME',
				defaultSubdir: '.copilot',
				sessionsSubdir: 'session-state',
			});
			expect(
				resolveAgentAccountKey('copilot-cli', { COPILOT_HOME: '/Users/me/.copilot-work' }, HOME)
			).toBe('/Users/me/.copilot-work');
			expect(resolveAgentAccountKey('copilot-cli', {}, HOME)).toBe('/Users/me/.copilot');
		});
	});
	describe('account dir names', () => {
		it('accepts the default dir and its per-account siblings', () => {
			expect(isAccountDirName('.claude', '.claude')).toBe(true);
			expect(isAccountDirName('.claude-work', '.claude')).toBe(true);
			expect(isAccountDirName('.codex-project-acc-1', '.codex')).toBe(true);
		});
		it('rejects an unrelated folder and a backup copy', () => {
			expect(isAccountDirName('.claudette', '.claude')).toBe(false);
			expect(isAccountDirName('.claude-backup', '.claude')).toBe(false);
			expect(isAccountDirName('.codex-old', '.codex')).toBe(false);
		});
	});
	describe('provider profile keys', () => {
		it('round-trips a provider with an account', () => {
			const key = providerProfileKey('claude-code', '/Users/me/.claude-smash');
			expect(parseProviderProfileKey(key)).toEqual({
				toolType: 'claude-code',
				accountKey: '/Users/me/.claude-smash',
			});
		});
		it('round-trips a provider with no account', () => {
			const key = providerProfileKey('opencode', null);
			expect(key).toBe('opencode');
			expect(parseProviderProfileKey(key)).toEqual({ toolType: 'opencode', accountKey: null });
		});
		it('splits on the first separator only, so a path containing one survives', () => {
			const weird = '/Users/me/odd::dir/.claude';
			const key = providerProfileKey('claude-code', weird);
			expect(parseProviderProfileKey(key)).toEqual({
				toolType: 'claude-code',
				accountKey: weird,
			});
		});
	});
	describe('profile labels', () => {
		it('names the account for a provider that has accounts', () => {
			expect(providerProfileShortLabel('claude-code', '/Users/me/.claude-smash')).toBe('smash');
			expect(providerProfileLabel('claude-code', '/Users/me/.claude-smash')).toBe(
				'Claude Code - smash'
			);
		});
		// "Default account" alone is the same phrase for every provider, so the
		// short label - the one a card badge prints on its own - names the provider.
		it('names the implicit default account after its provider', () => {
			expect(providerProfileShortLabel('claude-code', '/Users/me/.claude')).toBe(
				'Claude Code default'
			);
			expect(providerProfileShortLabel('codex', '/Users/me/.codex')).toBe('Codex default');
			expect(providerProfileShortLabel('claude-code', '/Users/me/.claude')).not.toBe(
				providerProfileShortLabel('codex', '/Users/me/.codex')
			);
			// The full label already carries the provider, so it is unchanged.
			expect(providerProfileLabel('codex', '/Users/me/.codex')).toBe('Codex - Default account');
			expect(providerProfileLabel('copilot-cli', '/Users/me/.copilot')).toBe(
				'Copilot-CLI - Default account'
			);
		});
		it('falls back to the provider name when there is no account', () => {
			expect(providerProfileShortLabel('opencode', null)).toBe('OpenCode');
			expect(providerProfileLabel('opencode', null)).toBe('OpenCode');
		});
	});
	describe('effectiveAgentCustomEnvVars', () => {
		const provider = { CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco' };
		it("uses the agent's own vars in place of the provider-level set, never a merge", () => {
			expect(effectiveAgentCustomEnvVars({ ANTHROPIC_API_KEY: 'k' }, provider)).toEqual({
				ANTHROPIC_API_KEY: 'k',
			});
			expect(effectiveAgentCustomEnvVars({}, provider)).toEqual({});
		});
		it('falls back to the provider-level set only when the agent has none', () => {
			expect(effectiveAgentCustomEnvVars(undefined, provider)).toBe(provider);
			expect(effectiveAgentCustomEnvVars(undefined, undefined)).toEqual({});
		});
	});
	describe('resolveAgentBillingCredential', () => {
		it('returns null for an agent on its login', () => {
			expect(
				resolveAgentBillingCredential('claude-code', {
					CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash',
				})
			).toBeNull();
		});
		it('identifies an API key by its last 4 characters, never the whole secret', () => {
			const credential = resolveAgentBillingCredential('claude-code', {
				ANTHROPIC_API_KEY: 'sk-ant-api03-secret-wXyZ',
			});
			expect(credential).toEqual({ kind: 'api-key', id: 'api-key:wXyZ', label: 'API key …wXyZ' });
			expect(JSON.stringify(credential)).not.toContain('secret');
			expect(resolveAgentBillingCredential('codex', { OPENAI_API_KEY: 'sk-proj-abcd' })?.id).toBe(
				'api-key:abcd'
			);
		});
		it('names a gateway by host and a cloud provider by name', () => {
			expect(
				resolveAgentBillingCredential('claude-code', {
					ANTHROPIC_BASE_URL: 'https://llm.example.com/v1',
				})?.label
			).toBe('llm.example.com');
			expect(
				resolveAgentBillingCredential('claude-code', { CLAUDE_CODE_USE_BEDROCK: '1' })?.label
			).toBe('AWS Bedrock');
		});
		it('ignores providers with no account split', () => {
			expect(resolveAgentBillingCredential('opencode', { ANTHROPIC_API_KEY: 'k' })).toBeNull();
		});
	});
	describe('resolveAgentProfile', () => {
		it('files a keyed agent under the key even when it also names a config dir', () => {
			expect(
				resolveAgentProfile(
					'claude-code',
					{ CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco', ANTHROPIC_API_KEY: 'sk-ant-a1b2' },
					HOME
				)
			).toMatchObject({
				key: 'claude-code::api-key:a1b2',
				accountKey: null,
				label: 'Claude Code - API key …a1b2',
				shortLabel: 'API key …a1b2',
			});
		});
		it('files a login agent under its config dir', () => {
			expect(
				resolveAgentProfile('claude-code', { CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash' }, HOME)
			).toMatchObject({
				key: 'claude-code::/Users/me/.claude-smash',
				accountKey: '/Users/me/.claude-smash',
				credential: null,
				shortLabel: 'smash',
			});
		});
		it('splits an SSH-remote agent into its own profile per host', () => {
			const env = { CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco' };
			const local = resolveAgentProfile('claude-code', env, HOME);
			const remote = resolveAgentProfile('claude-code', env, HOME, {
				id: 'r1',
				name: 'pedtome',
			});
			expect(remote).toMatchObject({
				key: 'claude-code::/Users/me/.claude-banaco@ssh:r1',
				accountKey: '/Users/me/.claude-banaco',
				sshRemoteId: 'r1',
				label: 'Claude Code - banaco @ pedtome',
				shortLabel: 'banaco @ pedtome',
			});
			expect(remote?.key).not.toBe(local?.key);
			expect(
				resolveAgentProfile('claude-code', env, HOME, { id: 'r2', name: 'linode' })?.key
			).not.toBe(remote?.key);
			// A deleted remote keeps its own bucket rather than folding into local.
			expect(resolveAgentProfile('claude-code', env, HOME, { id: 'gone' })?.shortLabel).toBe(
				'banaco @ unknown host'
			);
		});
		it('keeps a credential profile whole across hosts', () => {
			const env = { ANTHROPIC_API_KEY: 'sk-ant-a1b2' };
			expect(
				resolveAgentProfile('claude-code', env, HOME, { id: 'r1', name: 'pedtome' })
			).toMatchObject({ key: 'claude-code::api-key:a1b2', sshRemoteId: null });
		});
		it('returns null only while a login agent is waiting on $HOME', () => {
			expect(resolveAgentProfile('claude-code', {}, undefined)).toBeNull();
			expect(
				resolveAgentProfile('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-a1b2' }, undefined)
			).not.toBeNull();
			expect(resolveAgentProfile('opencode', {}, undefined)?.key).toBe('opencode');
		});
	});
	describe('makeAccountKeyHelpers', () => {
		it('derives short names the same way the quota panels always have', () => {
			const { deriveShortName, deriveDisplayName } = makeAccountKeyHelpers('.claude');
			expect(deriveShortName('/Users/me/.claude')).toBe('default');
			expect(deriveShortName('/Users/me/.claude-gmail')).toBe('gmail');
			expect(deriveShortName(undefined)).toBe('default');
			expect(deriveDisplayName('/Users/me/.claude')).toBe('Default account');
		});
	});
});
// Source: src/__tests__/shared/statsGroupRollup.test.ts
describe('', () => {
	type RollupData = Pick<StatsAggregation, 'bySessionByDay' | 'bySessionSource'> &
		Partial<Pick<StatsAggregation, 'bySessionTokens'>>;
	const GROUPS: GroupLike[] = [
		{ id: 'g-acme', name: 'Acme Corp', emoji: '🏢' },
		{ id: 'g-internal', name: 'Internal', emoji: '🔧' },
	];
	const SESSIONS: GroupMemberSession[] = [
		{ id: 's1', name: 'Acme API', groupId: 'g-acme', toolType: 'claude-code' },
		{ id: 's2', name: 'Acme Web', groupId: 'g-acme', toolType: 'codex' },
		{ id: 's3', name: 'Tooling', groupId: 'g-internal', toolType: 'claude-code' },
		{ id: 's4', name: 'Scratch', toolType: 'claude-code' },
	];
	function makeData(overrides: Partial<RollupData> = {}): RollupData {
		return {
			bySessionByDay: {},
			bySessionSource: {},
			...overrides,
		};
	}
	describe('groupSessions', () => {
		it('buckets sessions by groupId and returns Ungrouped last', () => {
			const buckets = groupSessions(GROUPS, SESSIONS);
			expect(buckets).toHaveLength(3);
			expect(buckets[0].group?.id).toBe('g-acme');
			expect(buckets[0].sessions.map((s) => s.id)).toEqual(['s1', 's2']);
			expect(buckets[1].group?.id).toBe('g-internal');
			expect(buckets[2].group).toBeNull();
			expect(buckets[2].sessions.map((s) => s.id)).toEqual(['s4']);
		});
		it('treats a groupId pointing at a deleted group as ungrouped', () => {
			// A dangling pointer must never make an agent vanish from the totals -
			// the Left Bar makes the same call in useSessionCategories.
			const orphan: GroupMemberSession = { id: 's9', name: 'Orphan', groupId: 'g-gone' };
			const buckets = groupSessions(GROUPS, [...SESSIONS, orphan]);
			expect(buckets[2].sessions.map((s) => s.id)).toEqual(['s4', 's9']);
		});
		it('keeps groups with no members as empty buckets', () => {
			const buckets = groupSessions(GROUPS, [SESSIONS[0]]);
			expect(buckets[1].group?.id).toBe('g-internal');
			expect(buckets[1].sessions).toEqual([]);
		});
	});
	describe('rollUpGroup', () => {
		it('sums queries and duration across members', () => {
			const data = makeData({
				bySessionByDay: {
					s1: [
						{ date: '2026-08-01', count: 3, duration: 3000 },
						{ date: '2026-08-02', count: 2, duration: 2000 },
					],
					s2: [{ date: '2026-08-02', count: 5, duration: 5000 }],
				},
			});
			const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);
			expect(result.queries).toBe(10);
			expect(result.duration).toBe(10000);
		});
		it('merges overlapping days into one sorted series rather than concatenating', () => {
			// Two agents active on the same day are one day of group activity. A
			// concatenated series would draw the same date twice and the sparkline
			// would read as a sawtooth instead of a trend.
			const data = makeData({
				bySessionByDay: {
					s1: [{ date: '2026-08-02', count: 3, duration: 3000 }],
					s2: [
						{ date: '2026-08-02', count: 5, duration: 5000 },
						{ date: '2026-08-01', count: 1, duration: 1000 },
					],
				},
			});
			const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);
			expect(result.byDay).toEqual([
				{ date: '2026-08-01', count: 1, duration: 1000 },
				{ date: '2026-08-02', count: 8, duration: 8000 },
			]);
		});
		it('computes auto percent from the summed source split', () => {
			const data = makeData({
				bySessionSource: {
					s1: { user: 10, auto: 30 },
					s2: { user: 10, auto: 0 },
				},
			});
			const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);
			expect(result.userQueries).toBe(20);
			expect(result.autoQueries).toBe(30);
			expect(result.autoPercent).toBe(60);
		});
		it('returns null auto percent when the group has no recorded queries', () => {
			// null, not 0 - "never ran" and "ran, all interactive" are different
			// facts, and the tile renders an em-dash for the first.
			const result = rollUpGroup([SESSIONS[0]], makeData());
			expect(result.autoPercent).toBeNull();
		});
		it('sums token and cost totals across members', () => {
			const data = makeData({
				bySessionTokens: {
					s1: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 10,
						cacheCreationTokens: 5,
						costUsd: 1.5,
						pricedQueries: 3,
					},
					s2: {
						inputTokens: 200,
						outputTokens: 100,
						cacheReadTokens: 20,
						cacheCreationTokens: 0,
						costUsd: 2.25,
						pricedQueries: 4,
					},
				},
			});
			const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], data);
			expect(result.tokens.inputTokens).toBe(300);
			expect(result.tokens.outputTokens).toBe(150);
			expect(result.tokens.cacheReadTokens).toBe(30);
			expect(result.tokens.cacheCreationTokens).toBe(5);
			expect(result.tokens.costUsd).toBeCloseTo(3.75);
			expect(result.tokens.pricedQueries).toBe(7);
			expect(totalTokens(result.tokens)).toBe(485);
		});
		it('reports zero priced queries when no member has token data', () => {
			// The distinction the UI needs: 40 queries and no usage rows is "not
			// recorded", not "$0.00 spent".
			const data = makeData({
				bySessionByDay: { s1: [{ date: '2026-08-01', count: 40, duration: 40000 }] },
			});
			const result = rollUpGroup([SESSIONS[0]], data);
			expect(result.queries).toBe(40);
			expect(result.tokens.pricedQueries).toBe(0);
			expect(result.tokens.costUsd).toBe(0);
		});
		it('collects the distinct providers its members use, sorted', () => {
			const result = rollUpGroup([SESSIONS[0], SESSIONS[1]], makeData());
			expect(result.providers).toEqual(['claude-code', 'codex']);
		});
		it('ignores sessions with no recorded activity instead of throwing', () => {
			const result = rollUpGroup([{ id: 'unknown', name: 'Unknown' }], makeData());
			expect(result.queries).toBe(0);
			expect(result.byDay).toEqual([]);
			expect(result.providers).toEqual([]);
		});
	});
	describe('rollUpGroupStats', () => {
		const data = makeData({
			bySessionByDay: {
				s1: [{ date: '2026-08-01', count: 4, duration: 4000 }],
				s3: [{ date: '2026-08-01', count: 1, duration: 1000 }],
				s4: [{ date: '2026-08-01', count: 7, duration: 7000 }],
			},
		});
		it('returns one rollup per non-empty group plus Ungrouped last', () => {
			const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);
			expect(rollups.map((r) => r.groupId)).toEqual(['g-acme', 'g-internal', UNGROUPED_ID]);
			expect(rollups[2].name).toBe(UNGROUPED_NAME);
			expect(rollups[2].isUngrouped).toBe(true);
			expect(rollups[0].isUngrouped).toBe(false);
		});
		it('omits empty groups by default', () => {
			const rollups = rollUpGroupStats(GROUPS, [SESSIONS[0]], data);
			expect(rollups.map((r) => r.groupId)).toEqual(['g-acme']);
		});
		it('keeps empty groups when asked', () => {
			const rollups = rollUpGroupStats(GROUPS, [SESSIONS[0]], data, {
				includeEmptyGroups: true,
				includeEmptyUngrouped: true,
			});
			expect(rollups.map((r) => r.groupId)).toEqual(['g-acme', 'g-internal', UNGROUPED_ID]);
			expect(rollups[1].memberCount).toBe(0);
		});
		it('carries the group name, emoji, and member list onto the rollup', () => {
			const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);
			expect(rollups[0].name).toBe('Acme Corp');
			expect(rollups[0].emoji).toBe('🏢');
			expect(rollups[0].memberCount).toBe(2);
			expect(rollups[0].sessions.map((s) => s.id)).toEqual(['s1', 's2']);
		});
		it('accounts for every query exactly once across all buckets', () => {
			// The property that makes group totals trustworthy: the tiles must
			// reconcile with the dashboard's overall total, so no session may be
			// counted twice or dropped.
			const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);
			const total = rollups.reduce((sum, r) => sum + r.queries, 0);
			expect(total).toBe(12);
		});
		it('returns no rollups when there are neither groups nor ungrouped agents', () => {
			expect(rollUpGroupStats([], [], data)).toEqual([]);
		});
		it('rolls every agent into Ungrouped when no groups exist', () => {
			const rollups = rollUpGroupStats([], SESSIONS, data);
			expect(rollups).toHaveLength(1);
			expect(rollups[0].groupId).toBe(UNGROUPED_ID);
			expect(rollups[0].memberCount).toBe(4);
		});
		it('tolerates an aggregation with no bySessionTokens (older main-process build)', () => {
			const rollups = rollUpGroupStats(GROUPS, SESSIONS, {
				bySessionByDay: data.bySessionByDay,
				bySessionSource: data.bySessionSource,
			});
			expect(rollups[0].tokens.pricedQueries).toBe(0);
			expect(rollups[0].queries).toBe(4);
		});
	});
});
// Source: src/__tests__/shared/snooze.test.ts
describe('', () => {
	// Fixed reference instant: Wednesday 2026-07-15, 10:30 local time.
	// Every relative assertion below is anchored to this so the suite is
	// timezone-stable and doesn't drift with the wall clock.
	const NOW = new Date(2026, 6, 15, 10, 30, 0, 0).getTime();
	/** Resolve an expression, failing loudly if it didn't parse. */
	function resolve(input: string, now = NOW): Date {
		const result = parseSnoozeInput(input, now);
		if (!result.ok) throw new Error(`expected "${input}" to parse, got: ${result.error}`);
		return new Date(result.at);
	}
	describe('parseSnoozeInput - durations', () => {
		it('parses compact duration shorthand', () => {
			expect(resolve('1d').getTime()).toBe(NOW + 24 * 60 * 60 * 1000);
			expect(resolve('10h').getTime()).toBe(NOW + 10 * 60 * 60 * 1000);
			expect(resolve('45m').getTime()).toBe(NOW + 45 * 60 * 1000);
		});
		it('parses spelled-out units and plurals', () => {
			expect(resolve('2 weeks').getTime()).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
			expect(resolve('3 days').getTime()).toBe(NOW + 3 * 24 * 60 * 60 * 1000);
			expect(resolve('1 hour').getTime()).toBe(NOW + 60 * 60 * 1000);
		});
		it('accepts a leading "in" and compound durations', () => {
			expect(resolve('in 2 hours').getTime()).toBe(NOW + 2 * 60 * 60 * 1000);
			expect(resolve('1d 4h').getTime()).toBe(NOW + 28 * 60 * 60 * 1000);
		});
		it('rejects trailing junk rather than silently ignoring it', () => {
			expect(parseSnoozeInput('2 weeks from bob', NOW).ok).toBe(false);
			expect(parseSnoozeInput('5 bananas', NOW).ok).toBe(false);
		});
	});
	describe('parseSnoozeInput - calendar keywords', () => {
		it('resolves tomorrow to the default hour', () => {
			const result = resolve('tomorrow');
			expect(result.getDate()).toBe(16);
			expect(result.getHours()).toBe(SNOOZE_DEFAULT_HOUR);
			expect(result.getMinutes()).toBe(0);
		});
		it('resolves next month to the 1st of the following month', () => {
			const result = resolve('next month');
			expect(result.getMonth()).toBe(7); // August
			expect(result.getDate()).toBe(1);
		});
		it('resolves this weekend to the upcoming Saturday', () => {
			const result = resolve('this weekend');
			expect(result.getDay()).toBe(6);
			expect(result.getDate()).toBe(18);
		});
		it('resolves next week to the upcoming Monday, not the week after', () => {
			// Regression guard: "next week" on a Wednesday means five days out.
			const result = resolve('next week');
			expect(result.getDay()).toBe(1);
			expect(result.getDate()).toBe(20);
		});
		it('resolves tonight to the evening of the same day', () => {
			const result = resolve('tonight');
			expect(result.getDate()).toBe(15);
			expect(result.getHours()).toBe(18);
		});
	});
	describe('parseSnoozeInput - weekdays', () => {
		it('resolves a bare weekday to its next occurrence', () => {
			const result = resolve('friday');
			expect(result.getDay()).toBe(5);
			expect(result.getDate()).toBe(17);
		});
		it('treats "next <weekday>" as the following week', () => {
			const result = resolve('next friday');
			expect(result.getDay()).toBe(5);
			expect(result.getDate()).toBe(24);
		});
		it('never resolves a weekday to today', () => {
			// NOW is a Wednesday; "wednesday" must mean the next one.
			const result = resolve('wednesday');
			expect(result.getDate()).toBe(22);
		});
		it('accepts abbreviations and a trailing time', () => {
			const result = resolve('fri 3pm');
			expect(result.getDay()).toBe(5);
			expect(result.getHours()).toBe(15);
		});
	});
	describe('parseSnoozeInput - times of day', () => {
		it('resolves a bare time later today', () => {
			const result = resolve('3pm');
			expect(result.getDate()).toBe(15);
			expect(result.getHours()).toBe(15);
		});
		it('rolls a bare time that already passed to tomorrow', () => {
			const result = resolve('9am');
			expect(result.getDate()).toBe(16);
			expect(result.getHours()).toBe(9);
		});
		it('accepts 24-hour, minutes, and "at"', () => {
			expect(resolve('15:45').getHours()).toBe(15);
			expect(resolve('15:45').getMinutes()).toBe(45);
			expect(resolve('tomorrow at 9am').getHours()).toBe(9);
		});
		it('handles noon and midnight', () => {
			expect(resolve('noon').getHours()).toBe(12);
			expect(resolve('tomorrow midnight').getHours()).toBe(0);
		});
	});
	describe('parseSnoozeInput - absolute dates', () => {
		it('parses ISO dates', () => {
			const result = resolve('2026-08-05');
			expect(result.getFullYear()).toBe(2026);
			expect(result.getMonth()).toBe(7);
			expect(result.getDate()).toBe(5);
			expect(result.getHours()).toBe(SNOOZE_DEFAULT_HOUR);
		});
		it('parses month-name forms in both orders', () => {
			expect(resolve('aug 5').getMonth()).toBe(7);
			expect(resolve('aug 5').getDate()).toBe(5);
			expect(resolve('5 august').getDate()).toBe(5);
			expect(resolve('august 5 2027').getFullYear()).toBe(2027);
		});
		it('parses US slash dates with an optional time', () => {
			expect(resolve('12/25').getMonth()).toBe(11);
			expect(resolve('12/25').getDate()).toBe(25);
			expect(resolve('12/25 6pm').getHours()).toBe(18);
		});
		it('rolls a bare month/day that already passed into next year', () => {
			// NOW is July 15 2026, so "jan 5" means January 2027.
			expect(resolve('jan 5').getFullYear()).toBe(2027);
			expect(resolve('1/5').getFullYear()).toBe(2027);
		});
		it('rejects impossible dates instead of overflowing into the next month', () => {
			expect(parseSnoozeInput('2026-02-31', NOW).ok).toBe(false);
			expect(parseSnoozeInput('2026-13-01', NOW).ok).toBe(false);
		});
	});
	describe('parseSnoozeInput - rejections', () => {
		it('rejects empty input', () => {
			expect(parseSnoozeInput('', NOW).ok).toBe(false);
			expect(parseSnoozeInput('   ', NOW).ok).toBe(false);
		});
		it('rejects unparseable text with a message naming the input', () => {
			const result = parseSnoozeInput('sometime soonish', NOW);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('sometime soonish');
		});
		it('rejects times in the past and sub-minute snoozes', () => {
			expect(parseSnoozeInput('2020-01-01', NOW).ok).toBe(false);
			expect(parseSnoozeInput('10s', NOW).ok).toBe(false);
		});
		it('accepts anything at least the minimum distance out', () => {
			const result = parseSnoozeInput('2m', NOW);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.at - NOW).toBeGreaterThanOrEqual(MIN_SNOOZE_MS);
		});
		it('is case and whitespace insensitive', () => {
			expect(resolve('  NEXT   MONTH  ').getMonth()).toBe(7);
			expect(resolve('ToMoRRoW').getDate()).toBe(16);
		});
	});
	describe('SNOOZE_PRESETS', () => {
		it('every preset resolves to a future time at the reference instant', () => {
			for (const preset of SNOOZE_PRESETS) {
				const result = parseSnoozeInput(preset.expression, NOW);
				expect(result.ok, `preset "${preset.id}" failed to resolve`).toBe(true);
				if (result.ok) expect(result.at).toBeGreaterThan(NOW);
			}
		});
		it('drops presets that would land in the past', () => {
			// At 11pm, "This evening" (6pm) is gone but "Tomorrow" survives. The modal
			// relies on this filter so it never renders an unusable button.
			const lateNight = new Date(2026, 6, 15, 23, 0, 0, 0).getTime();
			const usable = SNOOZE_PRESETS.filter((p) => parseSnoozeInput(p.expression, lateNight).ok);
			expect(usable.map((p) => p.id)).not.toContain('tonight');
			expect(usable.map((p) => p.id)).toContain('tomorrow');
		});
	});
	describe('formatters', () => {
		it('formats countdowns at the right granularity', () => {
			expect(formatSnoozeCountdown(NOW + 30 * 60 * 1000, NOW)).toBe('in 30 min');
			expect(formatSnoozeCountdown(NOW + 3 * 60 * 60 * 1000, NOW)).toBe('in 3 hours');
			expect(formatSnoozeCountdown(NOW + 1 * 60 * 60 * 1000, NOW)).toBe('in 1 hour');
			expect(formatSnoozeCountdown(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3 days');
			expect(formatSnoozeCountdown(NOW + 21 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3 weeks');
		});
		it('reports an elapsed target as "now"', () => {
			expect(formatSnoozeCountdown(NOW - 1000, NOW)).toBe('now');
		});
		it('includes the year only when it differs from the current one', () => {
			const thisYear = new Date(2026, 7, 5, 9, 0).getTime();
			const nextYear = new Date(2027, 7, 5, 9, 0).getTime();
			expect(formatSnoozeTarget(thisYear, NOW)).not.toContain('2026');
			expect(formatSnoozeTarget(nextYear, NOW)).toContain('2027');
		});
	});
});
