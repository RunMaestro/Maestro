/**
 * Tests for ProviderErrorTracker.
 * Validates sliding window error tracking, failover suggestion logic,
 * error type filtering, and session lifecycle management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderErrorTracker } from '../provider-error-tracker';
import type { ProviderSwitchConfig, FailoverSuggestion } from '../../../shared/account-types';

describe('ProviderErrorTracker', () => {
	let tracker: ProviderErrorTracker;
	let onFailoverSuggest: ReturnType<typeof vi.fn<(data: FailoverSuggestion) => void>>;
	const defaultConfig: ProviderSwitchConfig = {
		enabled: true,
		promptBeforeSwitch: true,
		errorThreshold: 3,
		errorWindowMs: 5 * 60 * 1000, // 5 minutes
		fallbackProviders: ['claude-code', 'opencode', 'codex'],
		switchBehavior: 'merge-back',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		onFailoverSuggest = vi.fn();
		tracker = new ProviderErrorTracker(defaultConfig, onFailoverSuggest);
	});

	describe('recordError', () => {
		it('should not record errors when disabled', () => {
			const disabledTracker = new ProviderErrorTracker(
				{ ...defaultConfig, enabled: false },
				onFailoverSuggest,
			);

			disabledTracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});

			const stats = disabledTracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(0);
		});

		it('should only count recoverable errors', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: false, // Non-recoverable
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(0);
		});

		it('should only count failover-worthy error types', () => {
			// token_exhaustion should not count
			tracker.recordError('session-1', 'claude-code', {
				type: 'token_exhaustion',
				message: 'Token limit reached',
				recoverable: true,
			});

			// session_not_found should not count
			tracker.recordError('session-1', 'claude-code', {
				type: 'session_not_found',
				message: 'Session not found',
				recoverable: true,
			});

			// permission_denied should not count
			tracker.recordError('session-1', 'claude-code', {
				type: 'permission_denied',
				message: 'Permission denied',
				recoverable: true,
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(0);
		});

		it('should count rate_limited errors toward threshold', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(1);
		});

		it('should count network_error toward threshold', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'network_error',
				message: 'Connection failed',
				recoverable: true,
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(1);
		});

		it('should count agent_crashed toward threshold', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'agent_crashed',
				message: 'Process exited',
				recoverable: true,
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(1);
		});

		it('should count auth_expired toward threshold', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'auth_expired',
				message: 'Auth expired',
				recoverable: true,
			});

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(1);
		});
	});

	describe('failover suggestion', () => {
		it('should emit failover suggestion when threshold is reached', () => {
			for (let i = 0; i < 3; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: `Rate limited ${i + 1}`,
					recoverable: true,
				});
			}

			expect(onFailoverSuggest).toHaveBeenCalledTimes(1);
			const suggestion: FailoverSuggestion = onFailoverSuggest.mock.calls[0][0];
			expect(suggestion.sessionId).toBe('session-1');
			expect(suggestion.currentProvider).toBe('opencode');
			expect(suggestion.suggestedProvider).toBe('claude-code'); // First in fallback list that isn't opencode
			expect(suggestion.errorCount).toBe(3);
			expect(suggestion.recentErrors).toHaveLength(3);
		});

		it('should not emit duplicate suggestions for the same session', () => {
			for (let i = 0; i < 5; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: `Rate limited ${i + 1}`,
					recoverable: true,
				});
			}

			// Should only be called once despite 5 errors
			expect(onFailoverSuggest).toHaveBeenCalledTimes(1);
		});

		it('should not emit suggestion below threshold', () => {
			for (let i = 0; i < 2; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: `Rate limited ${i + 1}`,
					recoverable: true,
				});
			}

			expect(onFailoverSuggest).not.toHaveBeenCalled();
		});

		it('should not emit suggestion when no fallback providers are available', () => {
			const noFallbackTracker = new ProviderErrorTracker(
				{ ...defaultConfig, fallbackProviders: ['opencode'] },
				onFailoverSuggest,
			);

			// All errors for opencode, but only opencode in fallback list
			for (let i = 0; i < 3; i++) {
				noFallbackTracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
				});
			}

			expect(onFailoverSuggest).not.toHaveBeenCalled();
		});

		it('should pick first available fallback provider that differs from current', () => {
			const tracker2 = new ProviderErrorTracker(
				{ ...defaultConfig, fallbackProviders: ['codex', 'opencode', 'claude-code'] },
				onFailoverSuggest,
			);

			for (let i = 0; i < 3; i++) {
				tracker2.recordError('session-1', 'codex', {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
				});
			}

			const suggestion: FailoverSuggestion = onFailoverSuggest.mock.calls[0][0];
			expect(suggestion.suggestedProvider).toBe('opencode');
		});
	});

	describe('clearSession', () => {
		it('should reset error count and allow re-suggestion', () => {
			// Hit threshold
			for (let i = 0; i < 3; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
				});
			}
			expect(onFailoverSuggest).toHaveBeenCalledTimes(1);

			// Clear session
			tracker.clearSession('session-1');

			const stats = tracker.getProviderStats('opencode');
			expect(stats.activeErrorCount).toBe(0);

			// Should be able to suggest again after clearing
			for (let i = 0; i < 3; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: 'Rate limited again',
					recoverable: true,
				});
			}
			expect(onFailoverSuggest).toHaveBeenCalledTimes(2);
		});
	});

	describe('removeSession', () => {
		it('should completely remove session from tracking', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});

			tracker.removeSession('session-1');

			const stats = tracker.getProviderStats('claude-code');
			expect(stats.activeErrorCount).toBe(0);
			expect(stats.sessionsWithErrors).toBe(0);
		});
	});

	describe('getProviderStats', () => {
		it('should aggregate stats across multiple sessions for the same provider', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});
			tracker.recordError('session-2', 'claude-code', {
				type: 'network_error',
				message: 'Network error',
				recoverable: true,
			});
			tracker.recordError('session-3', 'opencode', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});

			const claudeStats = tracker.getProviderStats('claude-code');
			expect(claudeStats.activeErrorCount).toBe(2);
			expect(claudeStats.sessionsWithErrors).toBe(2);

			const opencodeStats = tracker.getProviderStats('opencode');
			expect(opencodeStats.activeErrorCount).toBe(1);
			expect(opencodeStats.sessionsWithErrors).toBe(1);
		});

		it('should return zero stats for providers with no errors', () => {
			const stats = tracker.getProviderStats('codex');
			expect(stats.activeErrorCount).toBe(0);
			expect(stats.totalErrorsInWindow).toBe(0);
			expect(stats.lastErrorAt).toBeNull();
			expect(stats.sessionsWithErrors).toBe(0);
		});
	});

	describe('getAllStats', () => {
		it('should return stats for all tracked providers', () => {
			tracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited',
				recoverable: true,
			});
			tracker.recordError('session-2', 'opencode', {
				type: 'network_error',
				message: 'Network error',
				recoverable: true,
			});

			const allStats = tracker.getAllStats();
			expect(allStats.size).toBe(2);
			expect(allStats.has('claude-code')).toBe(true);
			expect(allStats.has('opencode')).toBe(true);
		});
	});

	describe('updateConfig', () => {
		it('should update the threshold dynamically', () => {
			// With threshold 3, two errors should not trigger
			tracker.recordError('session-1', 'opencode', {
				type: 'rate_limited',
				message: 'Rate limited 1',
				recoverable: true,
			});
			tracker.recordError('session-1', 'opencode', {
				type: 'rate_limited',
				message: 'Rate limited 2',
				recoverable: true,
			});
			expect(onFailoverSuggest).not.toHaveBeenCalled();

			// Lower threshold to 2 — the session already has 2 errors
			// Next error should trigger with the new threshold (need to hit new threshold)
			tracker.updateConfig({ ...defaultConfig, errorThreshold: 2 });

			// The existing 2 errors don't re-check — but the session already has 2 errors,
			// and failoverSuggested is still false, so the next check should trigger
			// Actually, errors are already recorded. Let's clear and re-record.
			tracker.clearSession('session-1');
			tracker.recordError('session-1', 'opencode', {
				type: 'rate_limited',
				message: 'Rate limited 1',
				recoverable: true,
			});
			tracker.recordError('session-1', 'opencode', {
				type: 'rate_limited',
				message: 'Rate limited 2',
				recoverable: true,
			});

			expect(onFailoverSuggest).toHaveBeenCalledTimes(1);
		});
	});

	describe('sliding window', () => {
		it('should prune errors older than the window', () => {
			// Use a short window for testing
			const shortWindowTracker = new ProviderErrorTracker(
				{ ...defaultConfig, errorWindowMs: 100 }, // 100ms window
				onFailoverSuggest,
			);

			// Record 2 errors
			shortWindowTracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited 1',
				recoverable: true,
			});
			shortWindowTracker.recordError('session-1', 'claude-code', {
				type: 'rate_limited',
				message: 'Rate limited 2',
				recoverable: true,
			});

			// Wait for the window to expire
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					// Record another error — old ones should be pruned
					shortWindowTracker.recordError('session-1', 'claude-code', {
						type: 'rate_limited',
						message: 'Rate limited 3',
						recoverable: true,
					});

					// Should only have 1 error in window (the new one)
					const stats = shortWindowTracker.getProviderStats('claude-code');
					expect(stats.activeErrorCount).toBe(1);
					// Should not have triggered failover (never had 3 in window)
					expect(onFailoverSuggest).not.toHaveBeenCalled();
					resolve();
				}, 150);
			});
		});
	});

	describe('session name resolution', () => {
		it('should use the provided session name resolver', () => {
			const nameResolver = vi.fn().mockReturnValue('My Session');
			const tracker2 = new ProviderErrorTracker(
				defaultConfig,
				onFailoverSuggest,
				nameResolver,
			);

			for (let i = 0; i < 3; i++) {
				tracker2.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
				});
			}

			expect(nameResolver).toHaveBeenCalledWith('session-1');
			const suggestion: FailoverSuggestion = onFailoverSuggest.mock.calls[0][0];
			expect(suggestion.sessionName).toBe('My Session');
		});

		it('should fall back to session ID when no resolver is provided', () => {
			for (let i = 0; i < 3; i++) {
				tracker.recordError('session-1', 'opencode', {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
				});
			}

			const suggestion: FailoverSuggestion = onFailoverSuggest.mock.calls[0][0];
			expect(suggestion.sessionName).toBe('session-1');
		});
	});
});
